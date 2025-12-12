// Start function - creates job and triggers background processing
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event, context) => {
    // Connect Lambda to enable automatic Blobs configuration
    connectLambda(event);
    
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        console.log('Creating job:', jobId);
        
        // Now getStore will work with automatic configuration
        const store = getStore('essay-jobs');
        
        // Save the job data and mark as processing
        await store.setJSON(jobId, {
            status: 'processing',
            input: body,
            timestamp: Date.now()
        });
        
        console.log('Job saved to Blobs');

        // Trigger the processor function (fire and forget)
        const siteUrl = process.env.URL || `https://${event.headers.host}`;
        fetch(`${siteUrl}/.netlify/functions/process-job`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId })
        }).catch(() => {});

        return {
            statusCode: 202,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, status: 'processing' })
        };

    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
