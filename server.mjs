// WHY(README.md): two servers so the checkout iframe is truly cross-origin.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MERCHANT_PORT = Number(process.env.MERCHANT_PORT ?? 4455)
const PROVIDER_PORT = Number(process.env.PROVIDER_PORT ?? 4456)
const MERCHANT_ORIGIN = `http://localhost:${MERCHANT_PORT}`
const PROVIDER_ORIGIN = `http://localhost:${PROVIDER_PORT}`
const RUNTYPE_API_URL = (process.env.RUNTYPE_API_URL ?? 'https://api.runtype.com').replace(
  /\/+$/,
  ''
)
const RUNTYPE_API_KEY = process.env.RUNTYPE_API_KEY
const MODEL = process.env.RUNTYPE_MODEL ?? 'claude-sonnet-5'

const PROVIDER_SECRET_KEY = 'sk_test_acmepay_demo'
const MERCHANT_WEBHOOK_SECRET = `whsec_${Buffer.from('acmepay-demo-merchant-endpoint!').toString('base64')}`
const RUNTYPE_WEBHOOK_CONFIG_FILE = join(HERE, 'runtype-webhook.local.json')
const RUNTYPE_WEBHOOK = existsSync(RUNTYPE_WEBHOOK_CONFIG_FILE)
  ? JSON.parse(readFileSync(RUNTYPE_WEBHOOK_CONFIG_FILE, 'utf8'))
  : null

if (!RUNTYPE_API_KEY) {
  console.error('Set RUNTYPE_API_KEY (a Runtype API key). See README.md.')
  process.exit(1)
}

const CATALOG = {
  'PAPER-A4': { name: 'Copy paper, A4, 500 sheets', unitAmount: 950 },
  'PEN-BLK-12': { name: 'Black gel pens, 12-pack', unitAmount: 1400 },
  'STAPLER-HD': { name: 'Heavy-duty stapler', unitAmount: 3200 },
  'NOTE-YLW-24': { name: 'Sticky notes, yellow, 24 pads', unitAmount: 1800 },
}

const SYSTEM_PROMPT = `You are the checkout assistant for Northwind Office Supply, a B2B office supply store.

Catalog (SKU: name, unit price in USD):
${Object.entries(CATALOG)
  .map(([sku, item]) => `- ${sku}: ${item.name}, $${(item.unitAmount / 100).toFixed(2)}`)
  .join('\n')}

Help the customer build an order. When they are ready to pay, show a short order summary with the
total, then call collect_payment with the SKUs and quantities. The tool opens the payment provider's
secure checkout; card details never pass through you. After the tool returns, do not repeat the
order summary. Reply in one or two sentences: on success, confirm the order number, amount and card
last four; if the payment was declined or the customer closed the checkout, say so plainly and offer
to try again. Never claim a payment succeeded unless the tool result says status "succeeded".`

const PERSONA_DIST = dirname(createRequire(import.meta.url).resolve('@runtypelabs/persona'))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
}

function sendFile(res, root, relPath) {
  const file = join(root, normalize(relPath).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(root) || !existsSync(file)) return sendJson(res, 404, { error: 'not found' })
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req) {
  const raw = await readBody(req)
  return raw ? JSON.parse(raw) : {}
}

function pipeUpstream(res, upstream) {
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-cache',
  })
  if (!upstream.body) return res.end()
  Readable.fromWeb(upstream.body).pipe(res)
}

function callRuntype(path, body) {
  return fetch(`${RUNTYPE_API_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RUNTYPE_API_KEY}`, 'content-type': 'application/json' },
    body,
  })
}

function callProvider(path, body) {
  return fetch(`${PROVIDER_ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${PROVIDER_SECRET_KEY}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json())
}

function priceItemsFromCatalog(items) {
  if (!Array.isArray(items) || items.length === 0)
    throw new Error('items must be a non-empty array')
  const lines = items.map(({ sku, quantity }) => {
    const product = CATALOG[sku]
    if (!product) throw new Error(`Unknown SKU: ${sku}`)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
      throw new Error(`Invalid quantity for ${sku}`)
    }
    return { sku, name: product.name, quantity, lineAmount: product.unitAmount * quantity }
  })
  return { lines, amount: lines.reduce((sum, line) => sum + line.lineAmount, 0) }
}

function standardWebhookSignature(secret, msgId, timestamp, raw) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return createHmac('sha256', key).update(`${msgId}.${timestamp}.${raw}`).digest('base64')
}

function isValidStandardWebhook(headers, raw, secret) {
  const msgId = headers['webhook-id']
  const timestamp = headers['webhook-timestamp']
  const signatures = String(headers['webhook-signature'] ?? '').split(' ')
  if (!msgId || !timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const expected = Buffer.from(standardWebhookSignature(secret, msgId, timestamp, raw))
  return signatures.some((entry) => {
    const [version, value] = entry.split(',')
    return (
      version === 'v1' &&
      value?.length === expected.length &&
      timingSafeEqual(Buffer.from(value), expected)
    )
  })
}

const orders = new Map()

async function handleMerchant(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/')
    return sendFile(res, join(HERE, 'public'), 'index.html')
  if (req.method === 'GET' && url.pathname.startsWith('/vendor/persona/')) {
    return sendFile(res, PERSONA_DIST, url.pathname.slice('/vendor/persona/'.length))
  }
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    return sendFile(res, join(HERE, 'public'), url.pathname.slice(1))
  }

  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    return sendJson(
      res,
      200,
      Object.entries(CATALOG).map(([sku, item]) => ({ sku, ...item }))
    )
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/dispatch') {
    const body = await readJson(req)
    // SAFETY: the agent's prompt and model are fixed server-side; the browser only sends messages + page tools.
    const upstream = await callRuntype(
      '/v1/dispatch',
      JSON.stringify({
        agent: {
          name: 'Northwind checkout assistant',
          model: MODEL,
          systemPrompt: SYSTEM_PROMPT,
          maxTurns: 8,
        },
        messages: (body.messages ?? []).map(({ role, content }) => ({ role, content })),
        clientTools: body.clientTools,
        options: { streamResponse: true, recordMode: 'virtual' },
      })
    )
    return pipeUpstream(res, upstream)
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/dispatch/resume') {
    return pipeUpstream(res, await callRuntype('/v1/dispatch/resume', await readBody(req)))
  }

  if (req.method === 'POST' && url.pathname === '/api/checkout-sessions') {
    const { items } = await readJson(req)
    // INVARIANT: the charge amount comes from the server-side catalog, never from the model's arguments.
    const { lines, amount } = priceItemsFromCatalog(items)
    const orderId = `NW-${randomBytes(3).toString('hex').toUpperCase()}`
    const intent = await callProvider('/v1/payment_intents', {
      amount,
      currency: 'usd',
      description: `Northwind order ${orderId}`,
      merchantOrigin: MERCHANT_ORIGIN,
      metadata: { orderId },
    })
    orders.set(orderId, { orderId, lines, amount, intentId: intent.id, webhookStatus: null })
    return sendJson(res, 200, {
      orderId,
      lines,
      amount,
      currency: 'usd',
      checkoutUrl: `${PROVIDER_ORIGIN}/checkout?client_secret=${encodeURIComponent(intent.clientSecret)}`,
      providerOrigin: PROVIDER_ORIGIN,
    })
  }

  const orderMatch = url.pathname.match(/^\/api\/checkout-sessions\/([A-Z0-9-]+)$/)
  if (req.method === 'GET' && orderMatch) {
    const order = orders.get(orderMatch[1])
    if (!order) return sendJson(res, 404, { error: 'unknown order' })
    // SAFETY: status is read from the provider's API, never trusted from the iframe's postMessage.
    const intent = await callProvider(`/v1/payment_intents/${order.intentId}`)
    return sendJson(res, 200, {
      orderId: order.orderId,
      status:
        intent.status === 'succeeded' ? 'succeeded' : intent.declineReason ? 'declined' : 'pending',
      paymentId: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      cardLast4: intent.cardLast4 ?? null,
      declineReason: intent.declineReason ?? null,
      webhookStatus: order.webhookStatus,
    })
  }

  const runtypeRecordMatch = url.pathname.match(
    /^\/api\/checkout-sessions\/([A-Z0-9-]+)\/runtype-record$/
  )
  if (req.method === 'GET' && runtypeRecordMatch) {
    if (!RUNTYPE_WEBHOOK) return sendJson(res, 200, { configured: false })
    const orderId = runtypeRecordMatch[1]
    const recordsRes = await fetch(
      `${RUNTYPE_WEBHOOK.apiUrl}/v1/records?type=northwind_orders&search=${encodeURIComponent(orderId)}&view=full`,
      { headers: { authorization: `Bearer ${RUNTYPE_API_KEY}` } }
    )
    const records = (await recordsRes.json()).data ?? []
    const record = records.find((r) => r.name === `order_${orderId}`)
    return sendJson(res, 200, {
      configured: true,
      record: record
        ? { id: record.id, name: record.name, updatedAt: record.updatedAt, ...record.metadata }
        : null,
    })
  }

  if (req.method === 'POST' && url.pathname === '/webhooks/acmepay') {
    const raw = await readBody(req)
    if (!isValidStandardWebhook(req.headers, raw, MERCHANT_WEBHOOK_SECRET)) {
      return sendJson(res, 400, { error: 'bad signature' })
    }
    const event = JSON.parse(raw)
    const order = orders.get(event.data.metadata?.orderId)
    if (order) order.webhookStatus = event.type
    console.log(`[merchant] webhook ${event.type} for ${event.data.metadata?.orderId}`)
    return sendJson(res, 200, { received: true })
  }

  return sendJson(res, 404, { error: 'not found' })
}

const intents = new Map()

const WEBHOOK_ENDPOINTS = [
  { name: 'merchant', url: `${MERCHANT_ORIGIN}/webhooks/acmepay`, secret: MERCHANT_WEBHOOK_SECRET },
  ...(RUNTYPE_WEBHOOK
    ? [{ name: 'runtype', url: RUNTYPE_WEBHOOK.webhookUrl, secret: RUNTYPE_WEBHOOK.signingSecret }]
    : []),
]

async function deliverWebhookEvent(event) {
  const raw = JSON.stringify(event)
  const msgId = `msg_${randomBytes(12).toString('hex')}`
  const timestamp = String(Math.floor(Date.now() / 1000))
  await Promise.all(
    WEBHOOK_ENDPOINTS.map(async (endpoint) => {
      try {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'webhook-id': msgId,
            'webhook-timestamp': timestamp,
            'webhook-signature': `v1,${standardWebhookSignature(endpoint.secret, msgId, timestamp, raw)}`,
          },
          body: raw,
        })
        console.log(
          `[provider] ${event.type} -> ${endpoint.name}: ${res.status} ${(await res.text()).slice(0, 160)}`
        )
      } catch (err) {
        console.error(`[provider] ${event.type} -> ${endpoint.name} failed`, err)
      }
    })
  )
}
const findIntentBySecret = (secret) => [...intents.values()].find((i) => i.clientSecret === secret)

async function handleProvider(req, res, url) {
  const authorized = req.headers.authorization === `Bearer ${PROVIDER_SECRET_KEY}`

  if (req.method === 'POST' && url.pathname === '/v1/payment_intents') {
    if (!authorized) return sendJson(res, 401, { error: 'unauthorized' })
    const body = await readJson(req)
    const intent = {
      id: `pi_${randomBytes(8).toString('hex')}`,
      clientSecret: `pi_secret_${randomBytes(12).toString('hex')}`,
      amount: body.amount,
      currency: body.currency,
      description: body.description,
      merchantOrigin: body.merchantOrigin,
      metadata: body.metadata ?? {},
      status: 'requires_payment_method',
    }
    intents.set(intent.id, intent)
    return sendJson(res, 200, intent)
  }

  const intentMatch = url.pathname.match(/^\/v1\/payment_intents\/(pi_[a-f0-9]+)$/)
  if (req.method === 'GET' && intentMatch) {
    if (!authorized) return sendJson(res, 401, { error: 'unauthorized' })
    const intent = intents.get(intentMatch[1])
    return intent ? sendJson(res, 200, intent) : sendJson(res, 404, { error: 'not found' })
  }

  if (req.method === 'GET' && url.pathname === '/checkout') {
    const intent = findIntentBySecret(url.searchParams.get('client_secret'))
    if (!intent) return sendJson(res, 404, { error: 'unknown checkout' })
    const checkout = {
      clientSecret: intent.clientSecret,
      amount: intent.amount,
      currency: intent.currency,
      description: intent.description,
      merchantOrigin: intent.merchantOrigin,
    }
    const html = readFileSync(join(HERE, 'provider/checkout.html'), 'utf8').replace(
      "'__CHECKOUT__'",
      JSON.stringify(checkout).replace(/</g, '\\u003c')
    )
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `frame-ancestors ${intent.merchantOrigin}`,
    })
    return res.end(html)
  }

  if (req.method === 'POST' && url.pathname === '/checkout/confirm') {
    const { clientSecret, cardNumber } = await readJson(req)
    const intent = findIntentBySecret(clientSecret)
    if (!intent) return sendJson(res, 404, { error: 'unknown checkout' })
    if (intent.status === 'succeeded') return sendJson(res, 409, { error: 'already paid' })
    const digits = String(cardNumber ?? '').replace(/\D/g, '')
    intent.cardLast4 = digits.slice(-4)
    const approved = digits === '4242424242424242'
    intent.status = approved ? 'succeeded' : 'requires_payment_method'
    intent.declineReason = approved ? undefined : 'card_declined'
    await deliverWebhookEvent({
      type: approved ? 'payment_intent.succeeded' : 'payment_intent.payment_failed',
      data: intent,
    })
    return sendJson(res, 200, { status: approved ? 'succeeded' : 'declined' })
  }

  return sendJson(res, 404, { error: 'not found' })
}

function serve(port, origin, handler, label) {
  createServer((req, res) =>
    handler(req, res, new URL(req.url, origin)).catch((err) => {
      console.error(`[${label}]`, err)
      if (!res.headersSent)
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    })
  ).listen(port, () => console.log(`${label.padEnd(16)} ${origin}`))
}

serve(MERCHANT_PORT, MERCHANT_ORIGIN, handleMerchant, 'Merchant site')
serve(PROVIDER_PORT, PROVIDER_ORIGIN, handleProvider, 'Acme Pay (mock)')
console.log(`${'Runtype API'.padEnd(16)} ${RUNTYPE_API_URL} (model ${MODEL})`)
console.log(
  `${'Runtype webhook'.padEnd(16)} ${RUNTYPE_WEBHOOK ? RUNTYPE_WEBHOOK.webhookUrl : 'not set up (run npm run setup:runtype)'}`
)
