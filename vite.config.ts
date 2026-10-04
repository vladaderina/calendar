import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const TARGET = 'https://api.open-meteo.com/v1'
const execFileAsync = promisify(execFile)

function weatherProxyPlugin() {
  return {
    name: 'vite-weather-proxy',
    configureServer(server: any) {
      server.middlewares.use('/api/weather', async (req: any, res: any) => {
        const suffix = req.url.replace(/^\/api\/weather/, '')
        const targetUrl = `${TARGET}${suffix}`
        try {
          // Node's fetch doesn't transparently use HTTP_PROXY/HTTPS_PROXY for
          // upstream HTTPS targets. Use curl (which respects the proxy env vars)
          // to fetch the weather data through the corporate proxy.
          const { stdout } = await execFileAsync('curl', [
            '--silent', '--show-error',
            '--noproxy', '',
            '--max-time', '15',
            targetUrl,
          ])
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(stdout)
        } catch (e: any) {
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end(`weather proxy error: ${e.message}`)
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    // Inject Supabase credentials as compile-time globals.
    // Vite replaces __SUPABASE_URL__ / __SUPABASE_ANON_KEY__ in all modules,
    // so import.meta.env is not needed (and doesn't work reliably in browser ESM).
    define: {
      __SUPABASE_URL__: JSON.stringify(env.VITE_SUPABASE_URL || ''),
      __SUPABASE_ANON_KEY__: JSON.stringify(env.VITE_SUPABASE_ANON_KEY || ''),
    },
    plugins: [react(), weatherProxyPlugin()],
    server: {
      host: true,
      port: 5173,
      strictPort: false,
      proxy: {
        '/api/weather': {
          target: TARGET,
          changeOrigin: true,
          secure: false,
          rewrite: (p: string) => p.replace(/^\/api\/weather/, ''),
        },
      },
    },
  }
})
