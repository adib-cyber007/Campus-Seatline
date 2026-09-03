import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
try {
  process.loadEnvFile?.(path.join(serverRoot, '.env'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Campus Seatline no longer uses an in-memory database.')
}

const { Pool } = pg
pg.types.setTypeParser(1082, value => value)

const databaseUrl = new URL(process.env.DATABASE_URL)
const connectionOptions = databaseUrl.searchParams.get('options') || ''
if (!/(?:^|\s)-c\s+timezone=/.test(connectionOptions)) {
  databaseUrl.searchParams.set('options', `${connectionOptions} -c timezone=UTC`.trim())
}
export const pool = new Pool({
  connectionString: databaseUrl.toString(),
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000
})

pool.on('error', error => {
  console.error('PostgreSQL pool error:', error)
})

export const sql = (text, values = []) => pool.query(text, values)

export async function withTransaction(work, { isolation = 'SERIALIZABLE', retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`)
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (attempt < retries && (error?.code === '40001' || error?.code === '40P01')) continue
      throw error
    } finally {
      client.release()
    }
  }
}

export async function applySchema() {
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql')
  const schema = await fs.readFile(schemaPath, 'utf8')
  await pool.query(schema)
}

export async function closeDatabase() {
  await pool.end()
}
