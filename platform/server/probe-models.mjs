import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock'
import { loadConfig } from './config.mjs'

const config = loadConfig()
const client = new BedrockClient({
  region: config.AWS_REGION || config.AWS_DEFAULT_REGION || 'us-west-2',
  credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY, sessionToken: config.AWS_SESSION_TOKEN },
})

const { modelSummaries } = await client.send(new ListFoundationModelsCommand({}))
const rows = modelSummaries.map(model => ({
  provider: model.providerName,
  id: model.modelId,
  name: model.modelName,
  streaming: model.responseStreamingSupported,
  inference: (model.inferenceTypesSupported || []).join('/'),
}))

const match = rows.filter(row => /deepseek|glm|zhipu|qwen|mistral|llama|nova/i.test(`${row.provider} ${row.id} ${row.name}`))
console.log(`Total models: ${rows.length}`)
console.table(match)

for (const term of ['deepseek', 'glm', 'zhipu']) {
  const hits = rows.filter(row => JSON.stringify(row).toLowerCase().includes(term))
  console.log(`\n"${term}": ${hits.length ? hits.map(h => h.id).join(', ') : 'NOT FOUND'}`)
}
