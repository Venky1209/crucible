// What can this key actually see? Run before picking LLM_MODEL.
import { listModels, providerLabel } from './llm.js';
try {
  const models = await listModels();
  console.log(`\n${providerLabel()}\n${models.length} models visible to this key:\n`);
  for (const m of models.sort()) console.log('  ' + m);
  console.log('');
} catch (e) {
  console.error(`\nCould not list models: ${e.message}\n`);
  process.exit(1);
}
