import { loadConfig } from './config.mjs';
import { createAws } from './aws.mjs';
console.log(JSON.stringify(await createAws(loadConfig()).probe(), null, 2));
