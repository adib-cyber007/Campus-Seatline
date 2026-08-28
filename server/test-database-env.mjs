import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const serverRoot = path.dirname(fileURLToPath(import.meta.url))
try {
  process.loadEnvFile?.(path.join(serverRoot, '.env'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required before running PostgreSQL integration tests.')
}

const bootstrapPool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
await bootstrapPool.query('CREATE SCHEMA IF NOT EXISTS seatline_test')
await bootstrapPool.end()

const databaseUrl = new URL(process.env.DATABASE_URL)
databaseUrl.searchParams.set('options', '-c search_path=seatline_test')
process.env.DATABASE_URL = databaseUrl.toString()
process.env.SEATLINE_TEST_SCHEMA = 'seatline_test'
