import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = join(HERE, 'runtype-webhook.local.json')
const RUNTYPE_API_URL = (process.env.RUNTYPE_API_URL ?? 'https://api.runtype.com').replace(
  /\/+$/,
  ''
)
const RUNTYPE_API_KEY = process.env.RUNTYPE_API_KEY
const force = process.argv.includes('--force')

if (!RUNTYPE_API_KEY) {
  console.error('Set RUNTYPE_API_KEY (a Runtype API key). See README.md.')
  process.exit(1)
}
if (existsSync(CONFIG_FILE) && !force) {
  console.log(readFileSync(CONFIG_FILE, 'utf8'))
  console.log(`Already set up. Delete ${CONFIG_FILE} or pass --force to create a new product.`)
  process.exit(0)
}

const NORMALIZE_PAYMENT_SCRIPT = `const d = input.data || {}
const meta = d.metadata || {}
const succeeded = input.type === 'payment_intent.succeeded'
if (!meta.orderId || !d.id) throw new Error('Not an Acme Pay payment event')
return {
  orderId: meta.orderId,
  paymentId: d.id,
  eventType: input.type,
  status: succeeded ? 'paid' : 'payment_failed',
  amountCents: d.amount,
  amount: (d.amount / 100).toFixed(2),
  currency: String(d.currency || 'usd').toUpperCase(),
  cardLast4: d.cardLast4 || null,
  declineReason: d.declineReason || null,
  fulfilment: succeeded ? 'ready_to_ship' : 'on_hold',
  receivedAt: new Date().toISOString()
}`

const CUSTOMER_MESSAGE_PROMPT = `Write the body of a customer email (3 sentences max) for this payment event.
Status: {{payment.status}}
Order: {{payment.orderId}}
Amount: {{payment.amount}} {{payment.currency}}
Card ending: {{payment.cardLast4}}
If the status is paid, confirm payment and say the order is being prepared for shipping. If the status is payment_failed, say the card was declined, nothing was charged, and they can reply in chat to try another card.`

const FLOW_STEPS = [
  {
    type: 'transform-data',
    name: 'Normalize payment event',
    config: {
      script: NORMALIZE_PAYMENT_SCRIPT,
      outputVariable: 'payment',
      errorHandling: { onError: 'fail' },
    },
  },
  {
    type: 'prompt',
    name: 'Draft customer message',
    config: {
      mode: 'task',
      model: 'claude-haiku-4-5',
      systemPrompt:
        'You write short, plain transactional emails for Northwind Office Supply, a B2B office supply store. No marketing language, no emoji, no placeholders.',
      userPrompt: CUSTOMER_MESSAGE_PROMPT,
      responseFormat: 'text',
      maxTokens: 300,
      outputVariable: 'customerMessage',
    },
  },
  {
    type: 'transform-data',
    name: 'Build order record',
    config: {
      script: 'return { ...input.payment, customerMessage: input.customerMessage }',
      outputVariable: 'orderRecord',
      errorHandling: { onError: 'fail' },
    },
  },
  {
    type: 'upsert-record',
    name: 'Save order payment',
    config: {
      recordType: 'northwind_orders',
      recordName: 'order_{{payment.orderId}}',
      sourceVariable: 'orderRecord',
      outputVariable: 'savedOrder',
    },
  },
]

const STANDARD_WEBHOOKS_SIGNING = {
  provider: 'standard-webhooks',
  algorithm: 'hmac-sha256',
  encoding: 'base64',
  headerName: 'webhook-signature',
  headerFormat: 'v1,{signature}',
  signedPayloadPattern: '{webhook-id}.{webhook-timestamp}.{body}',
  timestampTolerance: 300,
}

async function runtype(method, path, body) {
  const res = await fetch(`${RUNTYPE_API_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${RUNTYPE_API_KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(json)}`)
  return json
}

const idOf = (response) =>
  response.id ?? response.data?.id ?? response.product?.id ?? response.surface?.id

const validation = await runtype('POST', '/v1/public/flows/validate', {
  name: 'Northwind: record Acme Pay payment',
  flowSteps: FLOW_STEPS,
})
if (validation.valid === false)
  throw new Error(`Flow failed validation: ${JSON.stringify(validation.errors)}`)

const flowId = idOf(
  await runtype('POST', '/v1/flows', {
    name: 'Northwind: record Acme Pay payment',
    flowSteps: FLOW_STEPS,
  })
)
console.log(`Created flow        ${flowId}`)

const productId = idOf(
  await runtype('POST', '/v1/products', {
    name: 'Northwind payments',
    description: 'Receives signed Acme Pay payment webhooks and records each order payment.',
    status: 'active',
  })
)
console.log(`Created product     ${productId}`)

const capabilityId = idOf(
  await runtype('POST', `/v1/products/${productId}/capabilities`, {
    flowId,
    capabilityName: 'Record payment',
    capabilityDescription:
      'Normalize an Acme Pay payment event, draft the customer message, and upsert the order record.',
  })
)
console.log(`Added capability    ${capabilityId}`)

const signingSecret = `whsec_${randomBytes(32).toString('base64')}`
const surfaceId = idOf(
  await runtype('POST', `/v1/products/${productId}/surfaces`, {
    name: 'Acme Pay webhooks',
    type: 'webhook',
    config: {
      type: 'webhook',
      events: ['payment_intent.succeeded', 'payment_intent.payment_failed'],
      signingConfig: STANDARD_WEBHOOKS_SIGNING,
    },
    inbound: { secret: signingSecret },
  })
)
console.log(`Created surface     ${surfaceId}`)

await runtype('POST', `/v1/products/${productId}/surfaces/${surfaceId}/items`, {
  capabilityId,
  isEntryPoint: true,
  enabled: true,
})

const config = {
  apiUrl: RUNTYPE_API_URL,
  productId,
  surfaceId,
  flowId,
  webhookUrl: `${RUNTYPE_API_URL}/v1/products/${productId}/surfaces/${surfaceId}/webhook`,
  signingSecret,
}
writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Webhook URL         ${config.webhookUrl}`)
console.log(`Saved to ${CONFIG_FILE} (gitignored; holds the signing secret).`)
