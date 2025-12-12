// Check job status function
const { getStore } = require('@netlify/blobs');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const jobId = event.queryStringParameters?.jobId;
    if (!jobId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing jobId' }) };
    }

    try {
        console.log('Checking job:', jobId);
        
        // Use automatic configuration
        const store = getStore('essay-jobs');
        const result = await store.get(jobId, { type: 'json' });

        if (!result) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'processing' })
            };
        }

        console.log('Job status:', result.status);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result)
        };

    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
