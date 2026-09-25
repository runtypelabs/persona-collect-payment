import { initializeWebMCPPolyfill } from '/vendor/persona/webmcp-polyfill.js'

const { initAgentWidget, markdownPostprocessor } = window.AgentWidget
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const formatCents = (cents) => usd.format(cents / 100)

const logList = document.getElementById('log')

function logStep(title, detail, tone = 'info') {
  logList.querySelector('.log-empty')?.remove()
  const item = document.createElement('li')
  item.className = `log-item log-${tone}`
  const time = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  item.innerHTML = `<span class="log-marker"></span><div><div class="log-title"></div><div class="log-detail"></div></div><time></time>`
  item.querySelector('.log-title').textContent = title
  item.querySelector('.log-detail').textContent = detail ?? ''
  item.querySelector('time').textContent = time
  logList.append(item)
}

async function renderCatalog() {
  const catalog = await fetch('/api/catalog').then((r) => r.json())
  const list = document.getElementById('catalog')
  for (const product of catalog) {
    const card = document.createElement('li')
    card.className = 'product'
    card.innerHTML = `<div class="product-name"></div><div class="product-meta"><span class="sku"></span><span class="price"></span></div>`
    card.querySelector('.product-name').textContent = product.name
    card.querySelector('.sku').textContent = product.sku
    card.querySelector('.price').textContent = formatCents(product.unitAmount)
    list.append(card)
  }
  return catalog
}

const checkoutEl = document.getElementById('checkout')
const checkoutFrame = document.getElementById('checkout-frame')

function openProviderCheckout(session) {
  return new Promise((resolve) => {
    let lastAttempt = null
    const lines = document.getElementById('checkout-lines')
    lines.replaceChildren(
      ...session.lines.map((line) => {
        const li = document.createElement('li')
        li.innerHTML = '<span></span><span></span>'
        li.children[0].textContent = `${line.quantity} × ${line.name}`
        li.children[1].textContent = formatCents(line.lineAmount)
        return li
      })
    )
    document.getElementById('checkout-origin').textContent =
      `Order ${session.orderId} · served by ${session.providerOrigin}`

    const finish = (outcome) => {
      window.removeEventListener('message', onMessage)
      document.getElementById('checkout-close').removeEventListener('click', onClose)
      checkoutEl.hidden = true
      checkoutFrame.removeAttribute('src')
      resolve(outcome)
    }
    const onClose = () => finish(lastAttempt ?? 'closed')
    const onMessage = (event) => {
      if (event.origin !== session.providerOrigin || event.data?.source !== 'acmepay') return
      lastAttempt = event.data.status
      logStep(
        `Checkout reported "${event.data.status}"`,
        'postMessage from the provider iframe. Treated as a hint only; the server verifies it next.',
        event.data.status === 'succeeded' ? 'info' : 'warn'
      )
      if (event.data.status === 'succeeded') setTimeout(() => finish('succeeded'), 1400)
    }

    window.addEventListener('message', onMessage)
    document.getElementById('checkout-close').addEventListener('click', onClose)
    checkoutFrame.src = session.checkoutUrl
    checkoutEl.hidden = false
  })
}

let settledCheckout = null

async function confirmWithProviderCheckout(info) {
  if (info.toolName !== 'collect_payment') return false
  logStep('Agent called collect_payment', JSON.stringify(info.args))
  const response = await fetch('/api/checkout-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: info.args?.items }),
  })
  const session = await response.json()
  if (!response.ok) {
    settledCheckout = { error: session.error }
    logStep('Checkout not started', session.error, 'warn')
    return true
  }
  logStep(
    `Order ${session.orderId} priced by the server: ${formatCents(session.amount)}`,
    'Amount comes from the merchant catalog, not from the model. Provider payment intent created.'
  )
  const outcome = await openProviderCheckout(session)
  if (outcome === 'closed') {
    logStep('Customer closed the checkout', 'The agent is told the customer declined.', 'warn')
    return false
  }
  settledCheckout = { orderId: session.orderId, lines: session.lines }
  return true
}

async function collectPayment() {
  const checkout = settledCheckout
  settledCheckout = null
  if (!checkout) return { status: 'not_started' }
  if (checkout.error) return { status: 'error', error: checkout.error }
  const verified = await fetch(`/api/checkout-sessions/${checkout.orderId}`).then((r) => r.json())
  logStep(
    `Verified with the provider: ${verified.status}`,
    `Server-side call to the provider API. Webhook: ${verified.webhookStatus ?? 'not received yet'}. Result sent back to the agent.`,
    verified.status === 'succeeded' ? 'ok' : 'warn'
  )
  watchRuntypeOrderRecord(
    checkout.orderId,
    verified.status === 'succeeded' ? 'paid' : 'payment_failed'
  )
  return { ...verified, amount: formatCents(verified.amount), lines: checkout.lines }
}

async function watchRuntypeOrderRecord(orderId, expectedStatus) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const { configured, record } = await fetch(
      `/api/checkout-sessions/${orderId}/runtype-record`
    ).then((r) => r.json())
    if (!configured) return
    if (record?.status === expectedStatus) {
      logStep(
        `Runtype webhook flow saved ${record.name}: ${record.status}, ${record.fulfilment}`,
        `Signed Acme Pay webhook verified by a Runtype webhook surface, which ran a flow and upserted record ${record.id}. Drafted customer email: "${record.customerMessage}"`,
        'ok'
      )
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  logStep(
    'No Runtype order record yet',
    'The Runtype webhook flow has not finished after 45 seconds.',
    'warn'
  )
}

async function registerPageTools(catalog) {
  initializeWebMCPPolyfill()
  await document.modelContext.registerTool({
    name: 'collect_payment',
    title: 'Collect payment',
    description:
      "Charge the customer for an order. Opens the payment provider's secure checkout in the customer's browser and returns the verified result: status (succeeded, declined, error), orderId, paymentId, amount and card last four.",
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', enum: catalog.map((p) => p.sku) },
              quantity: { type: 'integer', minimum: 1 },
            },
            required: ['sku', 'quantity'],
          },
        },
      },
      required: ['items'],
    },
    execute: collectPayment,
  })
}

function readExecutionError(frame) {
  const error = frame.error
  if (typeof error === 'string') return error
  return error?.message ?? 'The assistant hit an error. Please try again.'
}

const catalog = await renderCatalog()
await registerPageTools(catalog)

const widget = initAgentWidget({
  target: '#chat',
  config: {
    apiUrl: '/api/chat/dispatch',
    launcher: {
      enabled: false,
      width: '100%',
      fullHeight: true,
      title: 'Order assistant',
      subtitle: 'Northwind Office Supply',
    },
    welcome: {
      title: 'Order supplies, pay in chat',
      subtitle: 'Tell me what you need. When you are ready, I will open a secure checkout.',
    },
    suggestionChips: [
      'I need 3 reams of copy paper and a heavy-duty stapler. I want to pay now.',
      'What pens do you carry?',
    ],
    copy: { inputPlaceholder: 'Ask about supplies or place an order…' },
    postprocessMessage: ({ text }) => markdownPostprocessor(text),
    parseSSEEvent: (frame) =>
      frame?.type === 'execution_error' ? { error: readExecutionError(frame) } : null,
    webmcp: {
      enabled: true,
      allowlist: ['collect_payment'],
      onConfirm: confirmWithProviderCheckout,
    },
  },
})
widget.open()
