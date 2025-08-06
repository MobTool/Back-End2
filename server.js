const express = require('express');
const app = express();
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const cors = require('cors');
const { Pool } = require('pg'); // For PostgreSQL RDS
const { CognitoJwtVerifier } = require('aws-jwt-verify'); // For Cognito token verification
const AWS = require('aws-sdk'); // For S3 integration
const multer = require('multer'); // For handling file uploads (though we'll use pre-signed URLs)

// --- Environment Variables Configuration ---
// Ensure these are set in your EC2 environment or a .env file (e.g., using dotenv)
const RDS_HOST = process.env.RDS_HOST;
const RDS_USER = process.env.RDS_USER;
const RDS_PASSWORD = process.env.RDS_PASSWORD;
const RDS_DATABASE = process.env.RDS_DATABASE;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

// --- Database Connection Pool (PostgreSQL RDS) ---
const pool = new Pool({
  host: RDS_HOST,
  user: RDS_USER,
  password: RDS_PASSWORD,
  database: RDS_DATABASE,
  port: 5432, // Default PostgreSQL port
  ssl: {
    rejectUnauthorized: false // Use this for development, for production use proper CA certs
  }
});

// Test DB connection
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error acquiring client from DB pool', err.stack);
  }
  client.query('SELECT NOW()', (err, result) => {
    release();
    if (err) {
      return console.error('Error executing query', err.stack);
    }
    console.log('Connected to RDS PostgreSQL:', result.rows[0].now);
  });
});

// --- AWS S3 Configuration ---
const s3 = new AWS.S3();
const upload = multer(); // Multer for handling file uploads (though we'll use pre-signed URLs)

// --- Cognito JWT Verifier ---
const verifier = CognitoJwtVerifier.create({
  userPoolId: COGNITO_USER_POOL_ID,
  clientId: COGNITO_CLIENT_ID,
  tokenUse: 'access' // Or 'id' depending on which token you send from frontend
});

// --- Middleware ---
app.use(cors()); // Enable CORS for all origins (adjust for production)
app.use(express.json()); // Parse JSON request bodies

// --- Authentication Middleware ---
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Authentication token required' });
  }

  try {
    const payload = await verifier.verify(token);
    req.user = {
      id: payload.sub, // Cognito User ID (sub)
      email: payload.email // User's email
    };
    next();
  } catch (err) {
    console.error('Token verification failed:', err);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// --- Swagger Setup ---
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Task Manager API',
      version: '1.0.0',
      description: 'CSIS445 Assignment 1 – Task Manager App (with RDS, Cognito, S3)',
    },
    servers: [{ url: 'http://localhost:3000' }], // Update this to your EC2 public IP/domain
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{
      bearerAuth: []
    }]
  },
  apis: ['./server.js'] // Point to this file for JSDoc comments
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// --- API Routes ---

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
  res.send('Hello, backend is working for CSIS445 assignment 1 (RDS, Cognito, S3 enabled)');
});

/**
 * @swagger
 * /tasks:
 *   get:
 *     summary: Get all tasks for the authenticated user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of tasks
 *       401:
 *         description: Unauthorized
 */
app.get('/tasks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query('SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

/**
 * @swagger
 * /tasks:
 *   post:
 *     summary: Create a new task for the authenticated user
 *     security:
 *       - bearerAuth: []
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
 *               attachmentFileName:
 *                 type: string
 *                 description: Optional file name for S3 attachment
 *     responses:
 *       201:
 *         description: Task created
 *       401:
 *         description: Unauthorized
 */
app.post('/tasks', authenticateToken, async (req, res) => {
  const { title, description, dueDate, priority, completed, attachmentFileName } = req.body;
  const userId = req.user.id;

  try {
    let attachmentUrl = null;
    if (attachmentFileName) {
      // Generate a pre-signed URL for the client to upload directly to S3
      const s3Key = `${userId}/${Date.now()}-${attachmentFileName}`; // Unique key for S3
      const s3Params = {
        Bucket: S3_BUCKET_NAME,
        Key: s3Key,
        Expires: 300, // URL expires in 5 minutes
        ContentType: 'application/octet-stream' // Or specific content type if known
      };
      attachmentUrl = await s3.getSignedUrlPromise('putObject', s3Params);
    }

    const query = `
      INSERT INTO tasks (user_id, title, description, due_date, priority, completed, attachment_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const values = [userId, title, description, dueDate, priority, completed || false, attachmentUrl];
    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

/**
 * @swagger
 * /tasks/{id}:
 *   put:
 *     summary: Update a task for the authenticated user
 *     security:
 *       - bearerAuth: []
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
 *               attachmentFileName:
 *                 type: string
 *                 description: Optional new file name for S3 attachment
 *     responses:
 *       200:
 *         description: Task updated
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Task not found or not owned by user
 */
app.put('/tasks/:id', authenticateToken, async (req, res) => {
  const taskId = req.params.id;
  const userId = req.user.id;
  const { title, description, dueDate, priority, completed, attachmentFileName } = req.body;

  try {
    let attachmentUrl = null;
    if (attachmentFileName) {
      const s3Key = `${userId}/${Date.now()}-${attachmentFileName}`;
      const s3Params = {
        Bucket: S3_BUCKET_NAME,
        Key: s3Key,
        Expires: 300,
        ContentType: 'application/octet-stream'
      };
      attachmentUrl = await s3.getSignedUrlPromise('putObject', s3Params);
    }

    const query = `
      UPDATE tasks
      SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        due_date = COALESCE($3, due_date),
        priority = COALESCE($4, priority),
        completed = COALESCE($5, completed),
        attachment_url = COALESCE($6, attachment_url)
      WHERE id = $7 AND user_id = $8
      RETURNING *;
    `;
    const values = [title, description, dueDate, priority, completed, attachmentUrl, taskId, userId];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found or not owned by user' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating task:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

/**
 * @swagger
 * /tasks/{id}:
 *   delete:
 *     summary: Delete a task for the authenticated user
 *     security:
 *       - bearerAuth: []
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
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Task not found or not owned by user
 */
app.delete('/tasks/:id', authenticateToken, async (req, res) => {
  const taskId = req.params.id;
  const userId = req.user.id;

  try {
    const query = 'DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING *;';
    const result = await pool.query(query, [taskId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found or not owned by user' });
    }
    res.status(204).send(); // No content
  } catch (err) {
    console.error('Error deleting task:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

/**
 * @swagger
 * /s3-upload-url:
 *   post:
 *     summary: Get a pre-signed URL for S3 file upload
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fileName:
 *                 type: string
 *                 description: Name of the file to upload
 *               fileType:
 *                 type: string
 *                 description: MIME type of the file (e.g., image/jpeg)
 *     responses:
 *       200:
 *         description: Pre-signed URL for upload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 uploadUrl:
 *                   type: string
 *                 fileUrl:
 *                   type: string
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Failed to generate URL
 */
app.post('/s3-upload-url', authenticateToken, async (req, res) => {
  const { fileName, fileType } = req.body;
  const userId = req.user.id;
  const s3Key = `${userId}/attachments/${Date.now()}-${fileName}`; // Unique key for S3

  const params = {
    Bucket: S3_BUCKET_NAME,
    Key: s3Key,
    Expires: 300, // URL expires in 5 minutes
    ContentType: fileType,
    ACL: 'private' // Keep files private, generate signed URLs for download if needed
  };

  try {
    const uploadUrl = await s3.getSignedUrlPromise('putObject', params);
    const fileUrl = `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${s3Key}`; // Publicly accessible URL (if ACL is public-read)
    // Note: If ACL is private, you'll need another pre-signed URL for download.
    res.json({ uploadUrl, fileUrl });
  } catch (err) {
    console.error('Error generating S3 pre-signed URL:', err);
    res.status(500).json({ error: 'Failed to generate S3 upload URL' });
  }
});


const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  console.log(`Swagger UI available at http://localhost:${PORT}/api-docs`);
});
