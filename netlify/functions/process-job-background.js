// Process job background function - calls Claude and saves result
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
        
        console.log('Processing job:', jobId);
        
        // Get the store
        store = getStore('essay-jobs');
        
        // Get the job data
        const job = await store.get(jobId, { type: 'json' });
        if (!job) {
            console.error('Job not found:', jobId);
            return; // Background functions don't return to client
        }

        const body = job.input;
        console.log('Subject:', body.subject);

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            await store.setJSON(jobId, { status: 'error', error: 'ANTHROPIC_API_KEY not configured' });
            return;
        }

        console.log('Calling Claude Sonnet...');
        const messages = buildMessages(body);
        const claudeData = await makeRequest(apiKey, messages);
        console.log('Claude response received');

        if (claudeData.error) {
            console.error('Claude error:', JSON.stringify(claudeData.error));
            await store.setJSON(jobId, { status: 'error', error: claudeData.error });
            return;
        }

        const config = extractJavaScript(claudeData.content[0].text);
        console.log('Config generated, length:', config.length);

        // Save the result
        await store.setJSON(jobId, {
            status: 'completed',
            config: config,
            timestamp: Date.now()
        });

        console.log('Result saved successfully');

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
        subject, yearGroup, examBoard, totalMarks, timeAllowed, paperName, gradeBoundaries,
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

    // Process and interpolate grade boundaries
    const processedBoundaries = processGradeBoundaries(gradeBoundaries, totalMarks);

    const prompt = `You are an expert educational content designer. Create a guided essay writing configuration.

## EXAM INFORMATION
- Subject: ${subject || 'Not specified'}
- Year Group: ${yearGroup || 'Not specified'}
- Exam Board: ${examBoard || 'Not specified'}
- Total Marks: ${totalMarks || 'Not specified'}
- Time Allowed: ${timeAllowed ? timeAllowed + ' minutes' : 'Not specified'}
${paperName ? `- Paper: ${paperName}` : ''}
${processedBoundaries ? `\n## GRADE BOUNDARIES\n${processedBoundaries}\n` : ''}

## EXAM QUESTION
${examQuestion || 'No question provided'}

${sourceMaterial ? `## SOURCE MATERIAL\n${sourceMaterial}\n` : ''}

## MARK SCHEME
${markScheme || 'No mark scheme provided - create appropriate criteria for this subject.'}

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
Generate a complete essay configuration with 4-6 paragraphs. Output ONLY valid JavaScript using this EXACT format:

\`\`\`javascript
window.ESSAYS = window.ESSAYS || {};
window.ESSAYS['[essay-id-here]'] = {
  id: '[essay-id-here]',
  title: "[Title for this essay task]",
  subject: "${subject || 'Subject'}",
  yearGroup: "${yearGroup || 'Year'}",
  essayTitle: "[The exam question]",
  instructions: "[Clear instructions for students]",
  originalTask: \`## Exam Question
[Full question]

## Mark Scheme Summary
[Key criteria]\`,
  maxAttempts: ${maxAttempts || 3},
  minWordsPerParagraph: ${minWords || 80},
  targetWordsPerParagraph: ${targetWords || 150},
  teacherPassword: "${teacherPassword || 'teacher123'}",
  paragraphs: [
    {
      id: 1,
      title: "Introduction",
      type: "introduction",
      learningMaterial: \`## Writing Your Introduction

[Detailed, specific guidance for this essay...]

### Key Points to Cover
- [Specific point 1]
- [Specific point 2]

### Sentence Starters
- "[Relevant starter]..."
\`,
      writingPrompt: "[Clear instruction]",
      keyPoints: ["[Mark scheme criterion]"],
      exampleQuotes: [],
      points: [marks]
    },
    // More body paragraphs with detailed guidance...
    {
      id: [n],
      title: "Conclusion",
      type: "conclusion",
      learningMaterial: \`## Writing Your Conclusion

[Specific guidance]
\`,
      writingPrompt: "[Instruction]",
      keyPoints: ["[Criterion]"],
      exampleQuotes: [],
      points: [marks]
    }
  ],
  gradingCriteria: {
    content: { weight: 30, description: "[From mark scheme]" },
    analysis: { weight: 30, description: "[From mark scheme]" },
    structure: { weight: 20, description: "[From mark scheme]" },
    expression: { weight: 20, description: "[From mark scheme]" }
  }
};
\`\`\`

Generate the complete configuration using ONLY plain ASCII characters:`;

    content.push({ type: 'text', text: prompt });
    return [{ role: 'user', content }];
}

function processGradeBoundaries(boundariesText, totalMarks) {
    if (!boundariesText || !boundariesText.trim()) {
        return null;
    }

    // Parse the input to extract grade-mark pairs
    const lines = boundariesText.split('\n').map(l => l.trim()).filter(l => l);
    const boundaries = [];
    
    for (const line of lines) {
        // Match patterns like "Grade 9: 36-40" or "9: 36-40" or "Grade A*: 80-100"
        const match = line.match(/(?:Grade\s+)?([A-Z\d*+]+)\s*:\s*(\d+)(?:\s*-\s*(\d+))?/i);
        if (match) {
            const grade = match[1].toUpperCase();
            const minMark = parseInt(match[2]);
            const maxMark = match[3] ? parseInt(match[3]) : minMark;
            boundaries.push({ grade, minMark, maxMark });
        }
    }

    if (boundaries.length === 0) {
        return boundariesText; // Return as-is if we can't parse it
    }

    // Sort by minMark descending (highest grade first)
    boundaries.sort((a, b) => b.minMark - a.minMark);

    // Determine grading system (numeric 9-1, A*-U, etc.)
    const isNumeric = boundaries.every(b => /^\d+$/.test(b.grade));
    
    if (isNumeric) {
        // Fill in missing numeric grades (9, 8, 7, 6, 5, 4, 3, 2, 1)
        const numericBoundaries = boundaries.map(b => ({
            ...b,
            gradeNum: parseInt(b.grade)
        }));

        const allGrades = [];
        const knownGrades = new Map(numericBoundaries.map(b => [b.gradeNum, b]));

        // Determine range (usually 9 to 1, but could be different)
        const maxGrade = Math.max(...numericBoundaries.map(b => b.gradeNum));
        const minGrade = Math.min(...numericBoundaries.map(b => b.gradeNum));

        for (let grade = maxGrade; grade >= minGrade; grade--) {
            if (knownGrades.has(grade)) {
                allGrades.push(knownGrades.get(grade));
            } else {
                // Interpolate
                const interpolated = interpolateGrade(grade, knownGrades, totalMarks);
                if (interpolated) {
                    allGrades.push(interpolated);
                }
            }
        }

        // Format output
        return allGrades.map(g => `Grade ${g.grade}: ${g.minMark}-${g.maxMark} marks`).join('\n');
    } else {
        // For letter grades, just return what was provided (interpolation is complex)
        return boundaries.map(b => `Grade ${b.grade}: ${b.minMark}-${b.maxMark} marks`).join('\n');
    }
}

function interpolateGrade(grade, knownGrades, totalMarks) {
    // Find the nearest known grades above and below
    let gradeAbove = null;
    let gradeBelow = null;

    const knownGradeNums = Array.from(knownGrades.keys()).sort((a, b) => b - a);
    
    for (const g of knownGradeNums) {
        if (g > grade && (gradeAbove === null || g < gradeAbove)) {
            gradeAbove = g;
        }
        if (g < grade && (gradeBelow === null || g > gradeBelow)) {
            gradeBelow = g;
        }
    }

    if (gradeAbove !== null && gradeBelow !== null) {
        // Interpolate between two known grades
        const upperBound = knownGrades.get(gradeAbove);
        const lowerBound = knownGrades.get(gradeBelow);
        
        const gradeDiff = gradeAbove - gradeBelow;
        const markDiff = upperBound.minMark - lowerBound.minMark;
        const markPerGrade = markDiff / gradeDiff;
        
        const minMark = Math.round(upperBound.minMark - (gradeAbove - grade) * markPerGrade);
        const maxMark = Math.round(minMark + markPerGrade - 1);
        
        return { grade: grade.toString(), gradeNum: grade, minMark, maxMark };
    } else if (gradeAbove !== null) {
        // Extrapolate below the lowest known grade
        const upperBound = knownGrades.get(gradeAbove);
        const avgMarkPerGrade = Math.floor(upperBound.minMark / gradeAbove);
        const minMark = Math.max(0, Math.round(upperBound.minMark - (gradeAbove - grade) * avgMarkPerGrade));
        const maxMark = Math.round(upperBound.minMark - 1);
        
        return { grade: grade.toString(), gradeNum: grade, minMark, maxMark };
    } else if (gradeBelow !== null) {
        // Extrapolate above the highest known grade
        const lowerBound = knownGrades.get(gradeBelow);
        const avgMarkPerGrade = Math.floor((totalMarks - lowerBound.minMark) / (10 - gradeBelow));
        const minMark = Math.round(lowerBound.maxMark + 1 + (grade - gradeBelow - 1) * avgMarkPerGrade);
        const maxMark = Math.min(totalMarks, Math.round(minMark + avgMarkPerGrade - 1));
        
        return { grade: grade.toString(), gradeNum: grade, minMark, maxMark };
    }

    return null;
}

function extractJavaScript(text) {
    const match = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();
    const configMatch = text.match(/(window\.ESSAY_CONFIG[\s\S]*};?)/);
    if (configMatch) return configMatch[1].trim();
    return text.trim();
}
