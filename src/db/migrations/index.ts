import { migration0001Init } from './0001_init.js';
import { migration0002CustomPromptsResources } from './0002_custom_prompts_resources.js';
import type { Migration } from '../client.js';

/** All migrations, in the order they must be applied. Add new ones at the end; never edit a released one in place. */
export const migrations: Migration[] = [migration0001Init, migration0002CustomPromptsResources];
