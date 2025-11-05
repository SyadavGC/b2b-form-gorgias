// api/b2b-form-submit.js
import axios from 'axios';
import FormData from 'form-data';

// Helper function to parse multipart form data
async function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = req.headers['content-type'].split('boundary=')[1];
        
        // Simple parser for multipart data
        const parts = buffer.toString().split(`--${boundary}`);
        const fields = {};
        let fileData = null;
        
        parts.forEach(part => {
          if (part.includes('Content-Disposition')) {
            const nameMatch = part.match(/name="([^"]+)"/);
            const filenameMatch = part.match(/filename="([^"]+)"/);
            
            if (filenameMatch) {
              // This is a file
              const contentTypeMatch = part.match(/Content-Type: ([^\r\n]+)/);
              const fileContent = part.split('\r\n\r\n')[1];
              const fileBuffer = Buffer.from(fileContent.split('\r\n--')[0], 'binary');
              
              fileData = {
                name: filenameMatch[1],
                data: fileBuffer,
                contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream'
              };
            } else if (nameMatch) {
              // This is a regular field
              const value = part.split('\r\n\r\n')[1]?.split('\r\n')[0];
              if (value) fields[nameMatch[1]] = value;
            }
          }
        });
        
        resolve({ fields, file: fileData });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

// Helper to create Basic Auth header
function getBasicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// Main handler function
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Set CORS headers for Shopify
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Parse the multipart form data
    const { fields, file } = await parseMultipartForm(req);
    
    const { companyName, email, organizationType, message } = fields;

    console.log('Processing submission:', { companyName, email, organizationType });

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Get Gorgias credentials from environment variables
    const GORGIAS_SUBDOMAIN = process.env.GORGIAS_SUBDOMAIN;
    const GORGIAS_USERNAME = process.env.GORGIAS_USERNAME;
    const GORGIAS_API_KEY = process.env.GORGIAS_API_KEY;
    const GORGIAS_EMAIL = process.env.GORGIAS_EMAIL;

    // Step 1: Upload file to Gorgias
    console.log('Uploading file to Gorgias...');
    
    const uploadForm = new FormData();
    uploadForm.append('file', file.data, {
      filename: file.name,
      contentType: file.contentType
    });

    const uploadResponse = await axios.post(
      `https://${GORGIAS_SUBDOMAIN}.gorgias.com/api/upload?type=attachment`,
      uploadForm,
      {
        headers: {
          'Authorization': getBasicAuth(GORGIAS_USERNAME, GORGIAS_API_KEY),
          ...uploadForm.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );

    console.log('File uploaded successfully:', uploadResponse.data);

    // Step 2: Create ticket with attachment
    const messageHtml = `
      <h3>B2B Form Submission</h3>
      <p><strong>Company:</strong> ${companyName}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Organization Type:</strong> ${organizationType}</p>
      <p><strong>Message:</strong></p>
      <p>${message ? message.replace(/\n/g, '<br>') : 'No message provided'}</p>
      <p><strong>Attached Document:</strong> ${file.name}</p>
    `;

    const messageText = `
B2B Form Submission
Company: ${companyName}
Email: ${email}
Organization Type: ${organizationType}
Message: ${message || 'No message provided'}
Attached Document: ${file.name}
    `;

    console.log('Creating Gorgias ticket...');

    const ticketResponse = await axios.post(
      `https://${GORGIAS_SUBDOMAIN}.gorgias.com/api/tickets`,
      {
        channel: 'email',
        via: 'api',
        customer: {
          email: email,
          name: companyName
        },
        messages: [
          {
            source: {
              type: 'email',
              to: [{ address: GORGIAS_EMAIL }],
              from: { address: email }
            },
            body_html: messageHtml,
            body_text: messageText,
            channel: 'email',
            from_agent: false,
            via: 'api',
            attachments: [
              {
                url: uploadResponse.data.url,
                name: uploadResponse.data.name,
                size: uploadResponse.data.size,
                content_type: uploadResponse.data.content_type
              }
            ]
          }
        ],
        subject: `B2B Form Submission - ${companyName}`,
        tags: ['b2b-form', organizationType]
      },
      {
        headers: {
          'Authorization': getBasicAuth(GORGIAS_USERNAME, GORGIAS_API_KEY),
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Ticket created successfully:', ticketResponse.data.id);

    // Return success response
    return res.status(200).json({
      success: true,
      ticketId: ticketResponse.data.id,
      message: 'Form submitted successfully',
      attachmentUrl: uploadResponse.data.url
    });

  } catch (error) {
    console.error('Error processing form:', error.response?.data || error.message);
    
    return res.status(500).json({
      error: 'Form submission failed',
      details: error.response?.data?.errors || error.message
    });
  }
}

// Vercel configuration
export const config = {
  api: {
    bodyParser: false, // Important: disable body parser for file uploads
  },
};
