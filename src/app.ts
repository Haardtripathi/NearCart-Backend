import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import morgan from 'morgan'

import corsOptions from './config/cors'
import env from './config/env'
import errorHandler from './middleware/errorHandler'
import notFoundHandler from './middleware/notFound'
import apiRoutes from './routes'

const app = express()

app.disable('x-powered-by')
// Required for express-rate-limit (and req.ip generally) to correctly
// identify clients behind a reverse proxy — see env.trustProxyHops for why
// this is not optional once rate limiting is in play.
app.set('trust proxy', env.trustProxyHops)

app.use(helmet())
app.use(cors(corsOptions))
app.use(express.json({ limit: env.requestBodyLimit }))
app.use(express.urlencoded({ extended: true, limit: env.requestBodyLimit }))
// Only log API traffic. The server is on a public IP, so internet-wide scanners (e.g. bots
// brute-forcing Synology NAS logins at /webapi/entry.cgi) were ~99% of the log — all 404s.
app.use(
  morgan(env.nodeEnv === 'production' ? 'combined' : 'dev', {
    skip: (request) => !request.originalUrl.startsWith('/api'),
  }),
)

app.get('/', (_request, response) => {
  response.status(200).json({
    appName: env.appName,
    message: 'NearKart main backend is running.',
  })
})

app.use('/api', apiRoutes)

app.use(notFoundHandler)
app.use(errorHandler)

export default app
