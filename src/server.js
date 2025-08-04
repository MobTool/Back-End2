require('dotenv').config();

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});


const express = require('express');
const app = express();
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const cors = require('cors');



app.use(cors());
app.use(express.json());

// Swagger setup
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Task Manager API',
      version: '1.0.0',
      description: 'CSIS445 Assignment 1 – Task Manager App',
    },
    servers: [{ url: 'http://localhost:3000' }],
  },
  apis: ['./src/server.js']
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @swagger
 * /:
 *   get:
 *     summary: Backend check
 *     description: Check if the backend is running
 *     responses:
 *       200:
 *         description: Backend is running
 */
app.get('/', (req, res) => {
  res.send('Hello, backend is working for CSIS445 assignment 1');
});

/**
 * @swagger
 * /tasks:
 *   get:
 *     summary: Get all tasks
 *     responses:
 *       200:
 *         description: List of tasks
 */

app.get('/tasks', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasks');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});


/**
 * @swagger
 * /tasks:
 *   post:
 *     summary: Create a new task
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               dueDate:
 *                 type: string
 *               priority:
 *                 type: string
 *               completed:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Task created
 */

app.post('/tasks', async (req, res) => {
  try {
    const { title, description, dueDate, priority, completed } = req.body;
    const id = Date.now();
    const createdAt = new Date().toISOString();

    await pool.query(
      'INSERT INTO tasks (id, title, description, dueDate, priority, completed, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, title, description, dueDate, priority, completed, createdAt]
    );

    res.status(201).json({ id, title, description, dueDate, priority, completed, createdAt });
  } catch (err) {
    res.status(500).json({ error: 'Database insert error' });
  }
});


/**
 * @swagger
 * /tasks/{id}:
 *   put:
 *     summary: Update a task
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Task ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               dueDate:
 *                 type: string
 *               priority:
 *                 type: string
 *               completed:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Task updated
 *       404:
 *         description: Task not found
 */
        // server.js (inside app.put('/tasks/:id'))
        app.put('/tasks/:id', authenticateToken, async (req, res) => {
            try {
                const taskId = req.params.id;
                const { title, description, dueDate, priority, completed } = req.body;

                // Construct the SET clause dynamically based on provided fields
                const updates = [];
                const values = [];
                if (title !== undefined) { updates.push('title = ?'); values.push(title); }
                if (description !== undefined) { updates.push('description = ?'); values.push(description); }
                if (dueDate !== undefined) { updates.push('dueDate = ?'); values.push(dueDate); }
                if (priority !== undefined) { updates.push('priority = ?'); values.push(priority); }
                if (completed !== undefined) { updates.push('completed = ?'); values.push(completed); }

                if (updates.length === 0) {
                    return res.status(400).json({ error: 'No fields to update' });
                }

                const query = `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`;
                values.push(taskId);

                const [result] = await pool.query(query, values);

                if (result.affectedRows === 0) {
                    return res.status(404).json({ error: 'Task not found' });
                }

                // Fetch the updated task to return it
                const [updatedTaskRows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
                res.json(updatedTaskRows[0]);

            } catch (err) {
                console.error('Database update error:', err);
                res.status(500).json({ error: 'Database update error' });
            }
        });
        

/**
 * @swagger
 * /tasks/{id}:
 *   delete:
 *     summary: Delete a task
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: Task ID
 *     responses:
 *       204:
 *         description: Task deleted
 *       404:
 *         description: Task not found
 */
        // server.js (inside app.delete('/tasks/:id'))
        app.delete('/tasks/:id', authenticateToken, async (req, res) => {
            try {
                const taskId = req.params.id;
                const [result] = await pool.query('DELETE FROM tasks WHERE id = ?', [taskId]);

                if (result.affectedRows === 0) {
                    return res.status(404).json({ error: 'Task not found' });
                }

                res.status(204).send(); // No content on successful deletion
            } catch (err) {
                console.error('Database delete error:', err);
                res.status(500).json({ error: 'Database delete error' });
            }
        });
        
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  console.log(`Swagger UI available at http://localhost:${PORT}/api-docs`);
});

        // server.js (add this section)
        const jwt = require('jsonwebtoken');
        const jwkToPem = require('jwk-to-pem');
        const fetch = require('node-fetch'); // You might need to install node-fetch

        let pems = {}; // Store public keys

        // Function to fetch and cache Cognito's public keys
        async function setupCognitoPems() {
            const cognitoRegion = process.env.COGNITO_REGION; // Get from env
            const userPoolId = process.env.COGNITO_USER_POOL_ID; // Get from env
            if (!cognitoRegion || !userPoolId) {
                console.error("Cognito region or user pool ID not set in environment variables.");
                return;
            }
            const url = `https://cognito-idp.${cognitoRegion}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
            try {
                const response = await fetch(url);
                const data = await response.json();
                pems = {};
                data.keys.forEach(key => {
                    pems[key.kid] = jwkToPem({ kty: key.kty, n: key.n, e: key.e });
                });
                console.log("Cognito PEMs loaded successfully.");
            } catch (error) {
                console.error("Failed to load Cognito PEMs:", error);
            }
        }

        // Call this on server start
        setupCognitoPems();

        // Middleware to authenticate requests
        const authenticateToken = (req, res, next) => {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.split(' ')[1];

            if (token == null) return res.sendStatus(401); // No token

            const decodedJwt = jwt.decode(token, { complete: true });
            if (!decodedJwt) {
                return res.status(401).json({ error: 'Invalid token format' });
            }

            const kid = decodedJwt.header.kid;
            const pem = pems[kid];

            if (!pem) {
                return res.status(401).json({ error: 'Invalid token: KID not found' });
            }

            jwt.verify(token, pem, { algorithms: ['RS256'] }, (err, user) => {
                if (err) {
                    console.error("JWT verification error:", err);
                    return res.status(403).json({ error: 'Forbidden: Invalid token' }); // Token invalid or expired
                }
                req.user = user; // Attach user info to request
                next();
            });
        };

        // Apply authentication middleware to protected routes
        // app.use(authenticateToken); // If you want to protect all routes
        // Or apply it to specific routes:
        app.get('/tasks', authenticateToken, async (req, res) => { /* ... */ });
        app.post('/tasks', authenticateToken, async (req, res) => { /* ... */ });
        app.put('/tasks/:id', authenticateToken, async (req, res) => { /* ... */ });
        app.delete('/tasks/:id', authenticateToken, async (req, res) => { /* ... */ });
        authenticatedFetch(`${config.API_BASE_URL}/tasks/${taskId}`, {/* ... */ });
                


