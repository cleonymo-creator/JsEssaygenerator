// Start search function - creates job and triggers background processing
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event, context) => {
    // Connect Lambda to enable automatic Blobs configuration
    connectLambda(event);
    
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const { examBoard, subject, paper, questionNumber } = body;

        if (!examBoard || !subject) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Exam board and subject are required' })
            };
        }

        const jobId = 'search_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        console.log('Creating search job:', jobId);
        
        const store = getStore('essay-jobs');
        
        // Save the job data and mark as processing
        await store.setJSON(jobId, {
            status: 'processing',
            input: { examBoard, subject, paper, questionNumber },
            timestamp: Date.now()
        });
        
        console.log('Search job saved to Blobs');

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
