// Check job status
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const jobId = event.queryStringParameters?.jobId;
    if (!jobId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing jobId' }) };
    }

    try {
        const store = getStore({
            name: 'essay-results',
            siteID: process.env.NETLIFY_SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN
        });

        const result = await store.get(jobId, { type: 'json' });
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result || { completed: false })
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
