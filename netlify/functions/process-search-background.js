// Process search background function - calls Claude with web search and saves result
// Named with -background suffix to enable 15 minute timeout
const https = require('https');
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event, context) => {
    // Connect Lambda to enable automatic Blobs configuration
    connectLambda(event);
    
    // Background functions don't return responses to clients
    // They just process and save results

    let jobId;
    let store;

    try {
        const { jobId: id } = JSON.parse(event.body);
        jobId = id;
        
        console.log('Processing search job:', jobId);
        
        // Get the store
        store = getStore('essay-jobs');
        
        // Get the job data
        const job = await store.get(jobId, { type: 'json' });
        if (!job) {
            console.error('Search job not found:', jobId);
            return;
        }

        const { examBoard, subject, paper, questionNumber } = job.input;
        console.log('Searching for:', { examBoard, subject, paper, questionNumber });

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            await store.setJSON(jobId, { status: 'error', error: 'ANTHROPIC_API_KEY not configured' });
            return;
        }

        console.log('Calling Claude with web search...');
        const result = await searchWithClaude(apiKey, examBoard, subject, paper, questionNumber);
        console.log('Search completed');

        // Save the result
        await store.setJSON(jobId, {
            status: 'completed',
            result: result,
            timestamp: Date.now()
        });

        console.log('Search result saved successfully');

    } catch (error) {
        console.error('Error:', error);
        if (store && jobId) {
            try {
                await store.setJSON(jobId, { status: 'error', error: error.message });
            } catch (e) {
                console.error('Failed to save error state:', e);
            }
        }
    }
};

async function searchWithClaude(apiKey, examBoard, subject, paper, questionNumber) {
    const systemPrompt = `You are an expert at finding UK exam past paper questions. Your task is to search for past paper questions and return structured information about them.

When you find past paper questions, extract and return:
1. The exact question text
2. The year/session (e.g., "June 2023", "November 2022")
3. The total marks available
4. Any source material or texts provided with the question
5. Mark scheme information if available

Focus on finding questions from the last 5 years. Look for questions on exam board websites, revision sites like Physics & Maths Tutor, Save My Exams, or official exam board specimen papers.

Return your findings as a JSON array of questions.`;

    const userPrompt = `Search for ${examBoard} ${subject}${paper ? ` ${paper}` : ''}${questionNumber ? ` Question ${questionNumber}` : ''} past paper questions.

Find as many different year versions of this question type as possible. For each question found, provide:
- year: The exam session (e.g., "June 2023")
- questionText: The full question as it appears on the paper
- totalMarks: Number of marks available
- sourceMaterial: Any texts, extracts, or data provided (if applicable)
- markScheme: Brief mark scheme summary if found
- paperName: The specific paper name/number
- sourceUrl: Where you found this question

Return your response as valid JSON in this exact format:
{
  "questions": [
    {
      "year": "June 2023",
      "questionText": "...",
      "totalMarks": 40,
      "sourceMaterial": "...",
      "markScheme": "...",
      "paperName": "Paper 2 Section B",
      "sourceUrl": "..."
    }
  ],
  "examInfo": {
    "examBoard": "${examBoard}",
    "subject": "${subject}",
    "paper": "${paper || 'Not specified'}",
    "questionNumber": "${questionNumber || 'Not specified'}"
  }
}

If you cannot find specific past papers, provide information about the typical question format and mark scheme for this type of question based on available examiner reports and specifications.`;

    const requestBody = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        tools: [{
            type: 'web_search_20250305',
            name: 'web_search'
        }],
        messages: [{
            role: 'user',
            content: userPrompt
        }],
        system: systemPrompt
    });

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.anthropic.com',
            port: 443,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    
                    if (res.statusCode !== 200) {
                        console.error('Claude API error:', parsed);
                        resolve({ error: parsed, questions: [] });
                        return;
                    }

                    // Extract the text response from Claude
                    const textContent = parsed.content
                        .filter(block => block.type === 'text')
                        .map(block => block.text)
                        .join('\n');

                    // Try to parse as JSON
                    try {
                        // Find JSON in the response
                        const jsonMatch = textContent.match(/\{[\s\S]*"questions"[\s\S]*\}/);
                        if (jsonMatch) {
                            const questionsData = JSON.parse(jsonMatch[0]);
                            resolve(questionsData);
                        } else {
                            // Return the raw text if no JSON found
                            resolve({
                                questions: [],
                                rawResponse: textContent,
                                examInfo: {
                                    examBoard,
                                    subject,
                                    paper: paper || 'Not specified',
                                    questionNumber: questionNumber || 'Not specified'
                                }
                            });
                        }
                    } catch (parseError) {
                        console.error('JSON parse error:', parseError);
                        resolve({
                            questions: [],
                            rawResponse: textContent,
                            examInfo: {
                                examBoard,
                                subject,
                                paper: paper || 'Not specified',
                                questionNumber: questionNumber || 'Not specified'
                            }
                        });
                    }
                } catch (e) {
                    console.error('Response parse error:', e);
                    resolve({ error: data, questions: [] });
                }
            });
        });
        
        req.on('error', (error) => {
            console.error('Request error:', error);
            reject(error);
        });
        
        req.write(requestBody);
        req.end();
    });
}
