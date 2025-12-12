// Main generation function - does everything in one call
// Uses Claude Sonnet with manual Blobs storage
const https = require('https');

let getStore;
try {
    getStore = require('@netlify/blobs').getStore;
} catch (e) {
    console.error('Failed to load @netlify/blobs:', e);
}

exports.handler = async (event, context) => {
    console.log('Function started');
    console.log('HTTP Method:', event.httpMethod);
    
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // Check environment variables
    console.log('NETLIFY_SITE_ID exists:', !!process.env.NETLIFY_SITE_ID);
    console.log('NETLIFY_BLOBS_TOKEN exists:', !!process.env.NETLIFY_BLOBS_TOKEN);
    console.log('ANTHROPIC_API_KEY exists:', !!process.env.ANTHROPIC_API_KEY);

    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    console.log('Job ID:', jobId);
    
    let store = null;
    
    // Try to initialize Blobs (but don't fail if it doesn't work)
    if (getStore && process.env.NETLIFY_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
        try {
            store = getStore({
                name: 'essay-results',
                siteID: process.env.NETLIFY_SITE_ID,
                token: process.env.NETLIFY_BLOBS_TOKEN
            });
            console.log('Blobs store initialized');
        } catch (error) {
            console.error('Blobs init error:', error.message);
        }
    } else {
        console.log('Blobs not configured, will return result directly');
    }

    try {
        const body = JSON.parse(event.body);
        console.log('Body parsed, subject:', body.subject);

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' })
            };
        }

        console.log('Building messages...');
        const messages = buildMessages(body);
        console.log('Messages built, calling Claude...');
        
        const claudeData = await makeRequest(apiKey, messages);
        console.log('Claude response received');

        if (claudeData.error) {
            console.error('Claude error:', JSON.stringify(claudeData.error));
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Claude API error', details: claudeData.error })
            };
        }

        const config = extractJavaScript(claudeData.content[0].text);
        console.log('Config extracted, length:', config.length);

        const result = { completed: true, config, jobId, timestamp: Date.now() };

        // Try to save to Blobs
        if (store) {
            try {
                await store.setJSON(jobId, result);
                console.log('Saved to Blobs');
            } catch (e) {
                console.error('Blobs save error:', e.message);
            }
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result)
        };

    } catch (error) {
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message, stack: error.stack })
        };
    }
};

function makeRequest(apiKey, messages) {
    return new Promise((resolve, reject) => {
        const requestBody = JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 8000,
            messages: messages
        });

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

        const req = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(response.statusCode !== 200 ? { error: parsed } : parsed);
                } catch (e) {
                    resolve({ error: data });
                }
            });
        });
        req.on('error', reject);
        req.write(requestBody);
        req.end();
    });
}

function buildMessages(data) {
    const {
        subject, yearGroup, examBoard, totalMarks, timeAllowed, paperName,
        examQuestion, sourceMaterial, sourceFiles, markScheme, markSchemeFile,
        additionalNotes, minWords, targetWords, maxAttempts, teacherPassword
    } = data;

    const content = [];

    if (sourceFiles?.length > 0) {
        for (const file of sourceFiles) {
            if (file.type === 'application/pdf') {
                content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.content } });
                content.push({ type: 'text', text: `[Source file: ${file.name}]` });
            } else if (file.type?.startsWith('image/')) {
                content.push({ type: 'image', source: { type: 'base64', media_type: file.type, data: file.content } });
                content.push({ type: 'text', text: `[Image: ${file.name}]` });
            }
        }
    }

    if (markSchemeFile?.type === 'application/pdf') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: markSchemeFile.content } });
        content.push({ type: 'text', text: `[Mark scheme: ${markSchemeFile.name}]` });
    }

    const prompt = `You are an expert educational content designer. Create a guided essay configuration.

EXAM: ${subject} | ${yearGroup} | ${examBoard || 'N/A'} | ${totalMarks} marks | ${timeAllowed || 'N/A'} min
${paperName ? `Paper: ${paperName}` : ''}

QUESTION:
${examQuestion}

${sourceMaterial ? `SOURCE MATERIAL:\n${sourceMaterial}\n` : ''}

MARK SCHEME:
${markScheme || 'Create appropriate criteria for ' + subject}

${additionalNotes ? `NOTES: ${additionalNotes}` : ''}

Settings: ${minWords || 80} min words, ${targetWords || 150} target, ${maxAttempts || 3} attempts, password: ${teacherPassword || 'teacher123'}

Generate ONLY JavaScript code - a complete window.ESSAY_CONFIG with 4-6 detailed paragraphs:

\`\`\`javascript
window.ESSAY_CONFIG = {
  title: "[Title]",
  subject: "${subject || 'Subject'}",
  yearGroup: "${yearGroup || 'Year'}",
  essayTitle: "[Question text]",
  instructions: "[Student instructions]",
  originalTask: \`## Question\\n[Full question]\\n\\n## Mark Scheme\\n[Summary]\`,
  maxAttempts: ${maxAttempts || 3},
  minWordsPerParagraph: ${minWords || 80},
  targetWordsPerParagraph: ${targetWords || 150},
  teacherPassword: "${teacherPassword || 'teacher123'}",
  paragraphs: [
    {
      id: 1,
      title: "Introduction",
      type: "introduction", 
      learningMaterial: \`## Introduction\\n\\n[Detailed guidance]\\n\\n### Key Points\\n- [Point]\\n\\n### Sentence Starters\\n- "[Starter]..."\`,
      writingPrompt: "[Instruction]",
      keyPoints: ["[Mark scheme point]"],
      exampleQuotes: [],
      points: [marks]
    },
    // 2-4 more body paragraphs...
    {
      id: [n],
      title: "Conclusion",
      type: "conclusion",
      learningMaterial: \`## Conclusion\\n\\n[Guidance]\`,
      writingPrompt: "[Instruction]",
      keyPoints: ["[Point]"],
      exampleQuotes: [],
      points: [marks]
    }
  ],
  gradingCriteria: {
    content: { weight: 40, description: "[From mark scheme]" },
    analysis: { weight: 40, description: "[From mark scheme]" },
    technical: { weight: 20, description: "[From mark scheme]" }
  }
};
\`\`\``;

    content.push({ type: 'text', text: prompt });
    return [{ role: 'user', content }];
}

function extractJavaScript(text) {
    const match = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();
    const configMatch = text.match(/(window\.ESSAY_CONFIG[\s\S]*};?)/);
    if (configMatch) return configMatch[1].trim();
    return text.trim();
}
