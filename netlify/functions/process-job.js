// Process job function - calls Claude and saves result
const https = require('https');
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event, context) => {
    // Connect Lambda to enable automatic Blobs configuration
    connectLambda(event);
    
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let jobId;
    let store;

    try {
        const { jobId: id } = JSON.parse(event.body);
        jobId = id;
        
        console.log('Processing job:', jobId);
        
        // Get the store
        store = getStore('essay-jobs');
        
        // Get the job data
        const job = await store.get(jobId, { type: 'json' });
        if (!job) {
            console.error('Job not found:', jobId);
            return { statusCode: 404, body: 'Job not found' };
        }

        const body = job.input;
        console.log('Subject:', body.subject);

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            await store.setJSON(jobId, { status: 'error', error: 'ANTHROPIC_API_KEY not configured' });
            return { statusCode: 200, body: 'Error saved' };
        }

        console.log('Calling Claude Sonnet...');
        const messages = buildMessages(body);
        const claudeData = await makeRequest(apiKey, messages);
        console.log('Claude response received');

        if (claudeData.error) {
            console.error('Claude error:', JSON.stringify(claudeData.error));
            await store.setJSON(jobId, { status: 'error', error: claudeData.error });
            return { statusCode: 200, body: 'Error saved' };
        }

        const config = extractJavaScript(claudeData.content[0].text);
        console.log('Config generated, length:', config.length);

        // Save the result
        await store.setJSON(jobId, {
            status: 'completed',
            config: config,
            timestamp: Date.now()
        });

        console.log('Result saved');
        return { statusCode: 200, body: 'Done' };

    } catch (error) {
        console.error('Error:', error);
        if (store && jobId) {
            try {
                await store.setJSON(jobId, { status: 'error', error: error.message });
            } catch (e) {}
        }
        return { statusCode: 500, body: error.message };
    }
};

function makeRequest(apiKey, messages) {
    return new Promise((resolve, reject) => {
        const requestBody = JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 16000,
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

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(res.statusCode !== 200 ? { error: parsed } : parsed);
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

    // Add source files
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

    // Add mark scheme file
    if (markSchemeFile?.type === 'application/pdf') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: markSchemeFile.content } });
        content.push({ type: 'text', text: `[Mark scheme: ${markSchemeFile.name}]` });
    }

    const prompt = `You are an expert educational content designer specialising in UK examination systems. Your task is to create a guided essay writing configuration that PRECISELY reflects the actual mark scheme provided.

## CRITICAL INSTRUCTION: MARK SCHEME FIDELITY
The mark scheme provided below is the AUTHORITATIVE source for how this essay should be assessed. You must:
1. Preserve the EXACT assessment objectives (AOs) or criteria categories used in the mark scheme
2. Include ALL level/band descriptors - not just the top band, but every level from lowest to highest
3. Use the EXACT mark allocations from the mark scheme
4. Retain the specific language and terminology from the mark scheme
5. DO NOT impose a generic structure (content/analysis/structure/expression) - use whatever structure the mark scheme actually specifies

## EXAM INFORMATION
- Subject: ${subject || 'Not specified'}
- Year Group: ${yearGroup || 'Not specified'}
- Exam Board: ${examBoard || 'Not specified'}
- Total Marks: ${totalMarks || 'Not specified'}
- Time Allowed: ${timeAllowed ? timeAllowed + ' minutes' : 'Not specified'}
${paperName ? `- Paper: ${paperName}` : ''}

## EXAM QUESTION
${examQuestion || 'No question provided'}

${sourceMaterial ? `## SOURCE MATERIAL\n${sourceMaterial}\n` : ''}

## MARK SCHEME (PRESERVE IN FULL)
${markScheme || 'No mark scheme provided - create appropriate criteria for this subject and exam board.'}

${additionalNotes ? `## TEACHER NOTES\n${additionalNotes}\n` : ''}

## CONFIGURATION SETTINGS
- Min words/paragraph: ${minWords || 80}
- Target words/paragraph: ${targetWords || 150}
- Max attempts: ${maxAttempts || 3}
- Teacher password: ${teacherPassword || 'teacher123'}

## IMPORTANT FORMATTING RULES
- Use ONLY plain ASCII characters - no special symbols, checkmarks, emojis, or accented characters
- Use simple dashes (-) or asterisks (*) for bullet points
- Avoid curly quotes - use straight quotes only
- The essay ID should be lowercase with hyphens (e.g., 'creative-writing-sunset')

## TASK
Generate a complete essay configuration. The structure must reflect what the mark scheme actually rewards.

### CRITICAL: gradingCriteria Structure
The gradingCriteria object must EXACTLY mirror the assessment objectives or criteria from the mark scheme. Examples:

If the mark scheme uses AO1/AO2/AO3/AO4:
\`\`\`
gradingCriteria: {
  AO1: { 
    weight: [actual marks], 
    maxMarks: [from scheme],
    description: "[exact AO1 description from mark scheme]",
    levelDescriptors: {
      level1: { marks: "1-2", descriptor: "[exact level 1 text]" },
      level2: { marks: "3-4", descriptor: "[exact level 2 text]" },
      level3: { marks: "5-6", descriptor: "[exact level 3 text]" },
      // ... all levels
    }
  },
  // ... other AOs
}
\`\`\`

If the mark scheme uses "Content and Organisation" / "Technical Accuracy":
\`\`\`
gradingCriteria: {
  contentAndOrganisation: {
    weight: [actual marks],
    maxMarks: [from scheme],
    description: "[description from mark scheme]",
    levelDescriptors: {
      level1: { marks: "1-6", descriptor: "[exact text]" },
      level2: { marks: "7-12", descriptor: "[exact text]" },
      level3: { marks: "13-18", descriptor: "[exact text]" },
      level4: { marks: "19-24", descriptor: "[exact text]" }
    }
  },
  technicalAccuracy: {
    weight: [actual marks],
    maxMarks: [from scheme],
    description: "[description from mark scheme]",
    levelDescriptors: {
      // all levels with exact descriptors
    }
  }
}
\`\`\`

Output ONLY valid JavaScript using this format:

\`\`\`javascript
window.ESSAYS = window.ESSAYS || {};
window.ESSAYS['[essay-id-here]'] = {
  id: '[essay-id-here]',
  title: "[Title for this essay task]",
  subject: "${subject || 'Subject'}",
  yearGroup: "${yearGroup || 'Year'}",
  examBoard: "${examBoard || 'Exam Board'}",
  essayTitle: "[The exam question - full text]",
  instructions: "[Clear instructions for students explaining the task and how they will be assessed]",
  
  // FULL MARK SCHEME - preserve complete text for reference
  fullMarkScheme: \`[Insert the COMPLETE mark scheme here - all levels, all criteria, all descriptors. This is the authoritative reference for assessment.]\`,
  
  // Original task info for student reference
  originalTask: \`## Exam Question
[Full question text]

## How You Will Be Assessed
[Summary of the assessment criteria from the mark scheme, explaining to students what examiners are looking for]\`,

  maxAttempts: ${maxAttempts || 3},
  minWordsPerParagraph: ${minWords || 80},
  targetWordsPerParagraph: ${targetWords || 150},
  teacherPassword: "${teacherPassword || 'teacher123'}",
  totalMarks: ${totalMarks || 40},
  
  paragraphs: [
    {
      id: 1,
      title: "[Paragraph title reflecting essay structure]",
      type: "introduction",
      learningMaterial: \`## Writing This Section

[Detailed, specific guidance for this essay that connects to the mark scheme criteria...]

### What the Mark Scheme Rewards
[Specific connection to relevant assessment objectives]

### Key Points to Cover
- [Specific point 1 linked to mark scheme]
- [Specific point 2 linked to mark scheme]

### Sentence Starters
- "[Relevant starter]..."
- "[Another starter]..."

### Common Mistakes to Avoid
- [Mistake that loses marks according to the scheme]
\`,
      writingPrompt: "[Clear instruction telling students what to write]",
      keyPoints: ["[Specific criterion from mark scheme this paragraph addresses]"],
      assessmentFocus: ["[Which AO or criteria this paragraph primarily targets]"],
      exampleQuotes: [],
      points: [marks allocated to this section]
    },
    // Additional body paragraphs - number should reflect what the question requires
    // Each with detailed learningMaterial connecting to the actual mark scheme
    {
      id: [n],
      title: "Conclusion",
      type: "conclusion",
      learningMaterial: \`## Writing Your Conclusion

[Specific guidance connecting to mark scheme requirements for conclusions]
\`,
      writingPrompt: "[Instruction]",
      keyPoints: ["[Criterion]"],
      assessmentFocus: ["[Relevant AO/criteria]"],
      exampleQuotes: [],
      points: [marks]
    }
  ],
  
  // CRITICAL: This must match the ACTUAL mark scheme structure
  // Use the exact categories, marks, and descriptors from the provided mark scheme
  // Include ALL levels, not just the top band
  gradingCriteria: {
    // Structure this to match the actual mark scheme categories
    // Examples shown above - adapt to match whatever the mark scheme actually uses
  }
};
\`\`\`

## FINAL CHECKLIST BEFORE OUTPUT
1. Does gradingCriteria use the EXACT categories from the mark scheme (not generic ones)?
2. Are ALL level descriptors included for each criterion (not just top band)?
3. Do the mark allocations match the actual mark scheme?
4. Is the fullMarkScheme field populated with the complete mark scheme text?
5. Does each paragraph's assessmentFocus link to actual mark scheme criteria?
6. Are the total marks correct?

Generate the complete configuration:`;

    content.push({ type: 'text', text: prompt });
    return [{ role: 'user', content }];
}

function extractJavaScript(text) {
    const match = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();
    const configMatch = text.match(/(window\.ESSAYS[\s\S]*};?)/);
    if (configMatch) return configMatch[1].trim();
    return text.trim();
}
