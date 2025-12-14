// Start grade boundary search - creates job and triggers background processing
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event, context) => {
    connectLambda(event);
    
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const { examBoard, subject, qualification, totalMarks } = body;

        if (!examBoard || !subject) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Exam board and subject are required' })
            };
        }

        const jobId = 'grades_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        console.log('Creating grade boundary search job:', jobId);
        
        const store = getStore('essay-jobs');
        
        await store.setJSON(jobId, {
            status: 'processing',
            input: { examBoard, subject, qualification, totalMarks },
            timestamp: Date.now()
        });
        
        console.log('Grade boundary job saved');

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
