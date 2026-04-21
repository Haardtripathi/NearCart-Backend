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

app.use(helmet())
app.use(cors(corsOptions))
app.use(express.json())
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'))

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
