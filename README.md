# Video Generation Application

![Node.js](https://img.shields.io/badge/Node.js-18.x-green)
![Express](https://img.shields.io/badge/Express-4.x-lightgrey)

Web application for generating detailed prompts and images to create long AI video contents through a Node.js 

## Features
- Video generation pipeline using BytePlus ModelArk LLM service, Deepseek -> Seedream -> Seedance 
- User authentication and authorization using Github
- Video storage on BytePlus Object Storage
- Web-based interface


## Quick Start

```bash
git clone https://github.com/vyvakz/ai-video-gen-app.git
cd ai-video-gen-app

Create a .env file with the following content:
    //Get the client id and secret from Github
    GITHUB_CLIENT_ID=
    GITHUB_CLIENT_SECRET=
    BASE_URL=http://localhost:3000
    //Get the Object Storage Credentials from BytePlus
    TOS_ACCESS_KEY=
    TOS_SECRET_KEY=
    TOS_REGION=
    TOS_ENDPOINT=
    TOS_BUCKET_NAME=
    //Get the LLM API key from BytePlus ModelArk service
    ARK_API_KEY=
    PORT=3000
    //Get the JWT secret from any jwt generator eg: https://jwtsecrets.com/
    JWT_SECRET=

Update index.html with your GitHub client in the following section
    // Redirect to GitHub OAuth
    const clientId = ''; // Replace with your actual client ID

Update server.js with your BytePlus model id the following section
    // Call text LLM to generate script
    try {
    const response = await axios.post(
      'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions',
      {
        model: "", //Update with your model ID from BytePlus DeepSeek V3 or equivalent

Update server.js with your BytePlus model id the following section  
    // Call text-to-image LLM
    const response = await axios.post(
        'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations',
        {
          model: "",  //Update with your model ID from BytePlus seedream or equivalent

Update server.js with your BytePlus model id the following section
    // Create video generation task
    const taskResponse = await axios.post(
      'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks',
      {
        model: "",//User your model ID from BytePlus seedance or equivalent
                 

//Install the dependencies and start the server
npm install
npm start
