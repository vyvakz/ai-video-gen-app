require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { TosClient } = require('@volcengine/tos-sdk');
const crypto = require('crypto');
const path = require('path');
const uuid = require('uuid');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const jwt = require('jsonwebtoken');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Initialize TOS client
const tosClient = new TosClient({
  accessKeyId: process.env.TOS_ACCESS_KEY,
  accessKeySecret: process.env.TOS_SECRET_KEY,
  region: process.env.TOS_REGION,
  endpoint: process.env.TOS_ENDPOINT,
});

// User management (in-memory for demo, use DB in production)
const users = {};
const videoGenerations = {};

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-strong-secret-key';

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// GitHub OAuth redirect
app.get('/auth/github', (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const redirectUri = encodeURIComponent(`${process.env.BASE_URL}/auth/github/callback`);
  const scope = 'user:email';
  
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}`);
});

// GitHub OAuth callback
app.get('/auth/github/callback', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    return res.redirect('/?error=missing_code');
  }
  
  try {
    // Exchange code for access token
    const tokenResponse = await axios.post('https://github.com/login/oauth/access_token', {
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${process.env.BASE_URL}/auth/github/callback`
    }, {
      headers: { 
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
    
    const accessToken = tokenResponse.data.access_token;
    
    // Get user info
    const userResponse = await axios.get('https://api.github.com/user', {
      headers: { 
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'VideoGenAI'
      }
    });
    
    const userData = userResponse.data;
    
    // Create user ID
    const userId = `github_${userData.id}`;
    
    // Create or update user
    if (!users[userId]) {
      users[userId] = {
        id: userId,
        githubId: userData.id,
        name: userData.name || userData.login,
        email: userData.email,
        avatar: userData.avatar_url,
        storagePath: `users/${userId}/`,
        scripts: [],
        thumbnails: [],
        videos: [],
        createdAt: new Date(),
        plan: 'Free',
        initials: getInitials(userData.name || userData.login)
      };
    }
    
    // Create JWT token
    const tokenPayload = {
      id: userId,
      name: users[userId].name,
      initials: users[userId].initials,
      plan: users[userId].plan
    };
    
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '1h' });
    
    // Redirect back to frontend with token
    res.redirect(`/?token=${encodeURIComponent(token)}`);
  } catch (error) {
    console.error('GitHub auth error:', error.response?.data || error.message);
    res.redirect('/?error=auth_failed');
  }
});

// Logout endpoint
app.post('/logout', (req, res) => {
  res.json({ success: true });
});

// Authentication middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }
  
  const token = authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Token missing' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Generate script endpoint
app.post('/generate-script', authenticate, async (req, res) => {
  const { userId, topic, contentType, duration } = req.body;
  
  // Create user directory if doesn't exist
  if (!users[userId]) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Call text LLM to generate script
  try {
    const response = await axios.post(
      'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions',
      {
        model: "", //Update with your model ID from BytePlus DeepSeek V3 or equivalent
        messages: [
          {
            role: "system",
            content: `You are a professional story script writer. Create a ${duration}-second ${contentType} video script about "${topic}". 
                      Divide into scenes of max 10 seconds each. Provide detailed descriptions for each scene including:
                      - Visual elements
                      - Camera movements
                      - Key actions
                      - Mood and atmosphere
                      - Text overlays (if any)`
          },
          {
            role: "user",
            content: `Generate a detailed scene-by-scene script for a ${duration}-second video about "${topic}"`
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.ARK_API_KEY}`
        }
      }
    );
    
    const script = response.data.choices[0].message.content;
    const scriptId = uuid.v4();
    
    
    // Save script to TOS
    const scriptKey = `${users[userId].storagePath}scripts/${scriptId}.txt`;
    await tosClient.putObject({
      bucket: process.env.TOS_BUCKET_NAME,
      key: scriptKey,
      body: script
    });
    
    users[userId].scripts.push({
      id: scriptId,
      script,
      topic,
      contentType,
      duration,
      key: scriptKey,
      createdAt: new Date()
    });
    
    res.json({ scriptId, script });
  } catch (error) {
    console.error('Script generation error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Script generation failed' });
  }
});

// Generate thumbnails endpoint
app.post('/generate-thumbnails', authenticate, async (req, res) => {
  const { userId, scriptId, style, count = 4 } = req.body;
  const user = users[userId];
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const script = user.scripts.find(s => s.id === scriptId);
  if (!script) return res.status(404).json({ error: 'Script not found' });
  
  try {
    const thumbnails = [];
    
    // Generate multiple thumbnails
    for (let i = 0; i < count; i++) {
      // Create prompt from script
      const prompt = `Create a ${style}-style image representing the video about "${script.script}". 
                     The image should capture the essence of the content in a visually compelling way with a focus on the intro.`;
      
      // Call text-to-image LLM
      const response = await axios.post(
        'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations',
        {
          model: "",  //Update with your model ID from BytePlus seedream or equivalent
          prompt,
          response_format: "url",
          size: "1024x1024",
          guidance_scale: 3,
          watermark: true
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.ARK_API_KEY}`
          }
        }
      );
      
      const imageUrl = response.data.data[0].url;
      const thumbnailId = uuid.v4();
      
      // Save to TOS
      const thumbnailKey = `${user.storagePath}thumbnails/${thumbnailId}.jpg`;
      const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      
      await tosClient.putObject({
        bucket: process.env.TOS_BUCKET_NAME,
        key: thumbnailKey,
        body: imageResponse.data,
        contentType: 'image/jpeg'
      });
      
      const publicUrl = `https://${process.env.TOS_BUCKET_NAME}.${process.env.TOS_ENDPOINT}/${thumbnailKey}`;
      
      thumbnails.push({
        id: thumbnailId,
        url: publicUrl,
        key: thumbnailKey
      });
    }
    
    // Save to user
    user.thumbnails = user.thumbnails || [];
    user.thumbnails.push(...thumbnails);
    
    res.json({ thumbnails });
  } catch (error) {
    console.error('Thumbnail generation error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Thumbnail generation failed' });
  }
});

// Start video generation
app.post('/start-video-generation', authenticate, async (req, res) => {
  const { userId, scriptId, thumbnailId } = req.body;
  const user = users[userId];
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const script = user.scripts.find(s => s.id === scriptId);
  const thumbnail = user.thumbnails.find(t => t.id === thumbnailId);
  
  if (!script || !thumbnail) {
    return res.status(404).json({ error: 'Script or thumbnail not found' });
  }
  
  // Create video generation task
  const videoGenerationId = uuid.v4();
  const segmentCount = Math.ceil(script.duration / 10);
  
  videoGenerations[videoGenerationId] = {
    userId,
    scriptId,
    thumbnailId,
    status: 'pending',
    segments: [],
    currentSegment: 0,
    progress: 0,
    totalSegments: segmentCount,
    createdAt: new Date()
  };
  
  res.json({ videoGenerationId });
});

// Generate single segment
app.post('/generate-segment', authenticate, async (req, res) => {
  const { videoGenerationId, segmentIndex, imageUrl } = req.body;
  const generation = videoGenerations[videoGenerationId];
  
  if (!generation) {
    return res.status(404).json({ error: 'Video generation not found' });
  }
  
  const user = users[generation.userId];
  const script = user.scripts.find(s => s.id === generation.scriptId);
  
  if (!script) {
    return res.status(404).json({ error: 'Script not found' });
  }
  
  try {
    const segmentDuration = Math.min(10, script.duration - (segmentIndex * 10));
    const segmentPrompt = `Scene ${segmentIndex+1}: ${script.content}`;
    console.log('segmentPrompt:', segmentPrompt);
    console.log('segmentDuration:', segmentDuration);
    // Create video generation task
    const taskResponse = await axios.post(
      'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks',
      {
        model: "",//User your model ID from BytePlus seedance or equivalent
        content: [
          {
            type: "text",
            text: `${segmentPrompt} --resolution 720p --duration ${segmentDuration} --camerafixed false`
          },
          {
            type: "image_url",
            image_url: {
              url: imageUrl
            }
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.ARK_API_KEY}`
        }
      }
    );
    console.log('taskResponseData:', taskResponse.data);
    const taskId = taskResponse.data.id;
    
    // Poll for task completion
    let status = 'running';
    let videoUrl = null;
    console.log('taskId:', taskId);
    while (status !== 'succeeded') {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const statusResponse = await axios.get(
        `https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/${taskId}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.ARK_API_KEY}`
          }
        }
      );
      console.log('statusResponseData:', statusResponse.data);
      status = statusResponse.data.status;
     if (status === 'succeeded') {
        videoUrl = statusResponse.data.content.video_url;
      } else if (status === 'failed') {
        throw new Error(statusResponse.data.error.message);
      }
    }
    
    // Extract last frame
    const frameUrl = await extractLastFrame(videoUrl, user, `${videoGenerationId}_${segmentIndex}`);
    
    // Update generation state
    generation.segments[segmentIndex] = {
      videoUrl,
      frameUrl
    };
    generation.currentSegment = segmentIndex;
    
    res.json({ 
      videoUrl, 
      frameUrl 
    });
  } catch (error) {
    console.error('Segment generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Extract last frame from video
async function extractLastFrame(videoUrl, user, prefix) {
  // Create temp directory if not exists
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }
  
  try {
    // Download video
    const videoResponse = await axios.get(videoUrl, { responseType: 'arraybuffer' });
    const tempVideoPath = path.join(tempDir, `${prefix}.mp4`);
    fs.writeFileSync(tempVideoPath, videoResponse.data);
    
    // Extract last frame
    const framePath = path.join(tempDir, `${prefix}.jpg`);
    
    await new Promise((resolve, reject) => {
      ffmpeg(tempVideoPath)
        .on('end', resolve)
        .on('error', reject)
        .screenshots({
          count: 1,
          timestamps: ['99%'],
          filename: `${prefix}.jpg`,
          folder: tempDir
        });
    });
    
    // Upload to TOS
    const frameKey = `${user.storagePath}frames/${prefix}.jpg`;
    const frameData = fs.readFileSync(framePath);
    
    await tosClient.putObject({
      bucket: process.env.TOS_BUCKET_NAME,
      key: frameKey,
      body: frameData,
      contentType: 'image/jpeg'
    });
    
    // Cleanup
    fs.unlinkSync(tempVideoPath);
    fs.unlinkSync(framePath);
    
    return `https://${process.env.TOS_BUCKET_NAME}.${process.env.TOS_ENDPOINT}/${frameKey}`;
  } catch (error) {
    console.error('Frame extraction error:', error);
    throw error;
  }
}

// Helper function to get initials from name
function getInitials(name) {
  if (!name) return 'US';
  
  return name.split(' ')
    .map(part => part[0])
    .join('')
    .toUpperCase()
    .substring(0, 2);
}

// Environment variable validation
if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
  console.error('Missing GitHub OAuth credentials. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables.');
  process.exit(1);
}

if (!process.env.BASE_URL) {
  console.error('Missing BASE_URL environment variable. Set to your application URL.');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`GitHub OAuth configured with client ID: ${process.env.GITHUB_CLIENT_ID}`);
});