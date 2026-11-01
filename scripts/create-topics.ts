import { createTopics } from './bootstrap';

createTopics().catch((error) => {
  console.error(error);
  process.exit(1);
});
