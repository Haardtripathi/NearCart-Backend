const cors = require('cors')
const express = require('express')
const helmet = require('helmet')
const morgan = require('morgan')

const corsOptions = require('./config/cors')
const env = require('./config/env')
const errorHandler = require('./middleware/errorHandler')
const notFoundHandler = require('./middleware/notFound')
const apiRoutes = require('./routes')

const app = express()

app.disable('x-powered-by')

app.use(helmet())
app.use(cors(corsOptions))
app.use(express.json())
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'))

app.get('/', (_request, response) => {
  response.status(200).json({
    appName: env.appName,
    message: 'NearCart main backend is running.',
  })
})

app.use('/api', apiRoutes)

app.use(notFoundHandler)
app.use(errorHandler)

module.exports = app
