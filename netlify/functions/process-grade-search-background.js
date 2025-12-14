// Process grade boundary search - calls Claude with web search and scales results
// Named with -background suffix to enable 15 minute timeout
const https = require('https');
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event, context) => {
    connectLambda(event);

    let jobId;
    let store;

    try {
        const { jobId: id } = JSON.parse(event.body);
        jobId = id;
        
        console.log('Processing grade boundary job:', jobId);
        
        store = getStore('essay-jobs');
        
        const job = await store.get(jobId, { type: 'json' });
        if (!job) {
            console.error('Job not found:', jobId);
            return;
        }

        const { examBoard, subject, qualification, totalMarks } = job.input;
        console.log('Searching grade boundaries for:', { examBoard, subject, qualification, totalMarks });

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            await store.setJSON(jobId, { status: 'error', error: 'ANTHROPIC_API_KEY not configured' });
            return;
        }

        console.log('Calling Claude with web search for grade boundaries...');
        const searchResult = await searchGradeBoundaries(apiKey, examBoard, subject, qualification);
        console.log('Search completed');

        // Scale the boundaries if we have totalMarks and found boundaries
        let scaledBoundaries = null;
        if (searchResult.boundaries && searchResult.boundaries.length > 0 && totalMarks) {
            scaledBoundaries = scaleBoundaries(searchResult.boundaries, searchResult.maxMark, totalMarks);
        }

        await store.setJSON(jobId, {
            status: 'completed',
            result: {
                ...searchResult,
                scaledBoundaries,
                targetMarks: totalMarks
            },
            timestamp: Date.now()
        });

        console.log('Grade boundary result saved');

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

function scaleBoundaries(boundaries, originalMax, targetMax) {
    if (!originalMax || originalMax === 0) return boundaries;
    
    const scale = targetMax / originalMax;
    
    return boundaries.map(b => ({
        grade: b.grade,
        minMarks: Math.round(b.minMarks * scale),
        maxMarks: b.maxMarks ? Math.round(b.maxMarks * scale) : null,
        originalMin: b.minMarks,
        originalMax: b.maxMarks
    }));
}

async function searchGradeBoundaries(apiKey, examBoard, subject, qualification) {
    const systemPrompt = `You are an expert at finding UK exam grade boundaries. Search for the most recent official grade boundaries from the exam board's website.

Return the data as JSON with this structure:
{
  "year": "2024",
  "session": "June",
  "examBoard": "AQA",
  "qualification": "GCSE",
  "subject": "English Language",
  "component": "Paper 2" or "Overall" if whole qualification,
  "maxMark": 80,
  "boundaries": [
    {"grade": "9", "minMarks": 64},
    {"grade": "8", "minMarks": 55},
    {"grade": "7", "minMarks": 46},
    {"grade": "6", "minMarks": 37},
    {"grade": "5", "minMarks": 28},
    {"grade": "4", "minMarks": 19},
    {"grade": "3", "minMarks": 10},
    {"grade": "2", "minMarks": 5},
    {"grade": "1", "minMarks": 1}
  ],
  "sourceUrl": "https://..."
}

For A-Level use grades: A*, A, B, C, D, E
For GCSE use grades: 9, 8, 7, 6, 5, 4, 3, 2, 1
For IB use levels: 7, 6, 5, 4, 3, 2, 1

Always include the maxMark (total marks available) so boundaries can be scaled.`;

    const qualText = qualification ? ` ${qualification}` : '';
    const userPrompt = `Search for the most recent official grade boundaries for ${examBoard}${qualText} ${subject}.

Look on the official ${examBoard} website for grade boundary documents. Find the most recent available year (2024, 2023, or 2022).

Return ONLY valid JSON with the grade boundaries. If you find component-specific boundaries, prefer those for the writing/essay component if identifiable, otherwise use the overall qualification boundaries.`;

    const requestBody = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
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
                        resolve({ error: parsed, boundaries: [] });
                        return;
                    }

                    const textContent = parsed.content
                        .filter(block => block.type === 'text')
                        .map(block => block.text)
                        .join('\n');

                    // Extract JSON from response
                    const jsonMatch = textContent.match(/\{[\s\S]*"boundaries"[\s\S]*\}/);
                    if (jsonMatch) {
                        try {
                            const boundaryData = JSON.parse(jsonMatch[0]);
                            resolve(boundaryData);
                        } catch (e) {
                            console.error('JSON parse error:', e);
                            resolve({ error: 'Could not parse grade boundaries', rawResponse: textContent, boundaries: [] });
                        }
                    } else {
                        resolve({ error: 'No grade boundaries found', rawResponse: textContent, boundaries: [] });
                    }
                } catch (e) {
                    console.error('Response parse error:', e);
                    resolve({ error: String(e), boundaries: [] });
                }
            });
        });
        
        req.on('error', reject);
        req.write(requestBody);
        req.end();
    });
}
