import { defineConfig, env } from 'prisma/config';
import { loadRepositoryEnv } from './src/config/load-env.js';

loadRepositoryEnv();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
});
