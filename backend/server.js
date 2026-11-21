const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const app = express();

app.use(cors());
app.use(express.json());



// =====================================================
// CREATE KNOWLEDGE FOLDER IF NOT EXISTS
// =====================================================

const knowledgePath =
    path.join(__dirname, "knowledge");

if (!fs.existsSync(knowledgePath)) {

    fs.mkdirSync(knowledgePath);

}



// =====================================================
// MULTER STORAGE
// =====================================================

const storage = multer.diskStorage({

    destination: function (req, file, cb) {

        cb(null, "knowledge/");

    },

    filename: function (req, file, cb) {

        cb(null, file.originalname);

    }

});

const upload = multer({ storage });



// =====================================================
// FILE UPLOAD API
// =====================================================

app.post(
    "/upload",
    upload.single("file"),
    (req, res) => {

        res.json({
            message: "File uploaded successfully"
        });

    }
);



// =====================================================
// SEARCH FUNCTION
// =====================================================

function searchKnowledge(question) {

    const files =
        fs.readdirSync(knowledgePath);

    let relevantData = "";

    files.forEach((file) => {

        try {

            const filePath =
                path.join(knowledgePath, file);

            const data =
                fs.readFileSync(filePath, "utf8");



            // SPLIT HUGE FILES INTO CHUNKS
            const chunkSize = 5000;

            for (
                let i = 0;
                i < data.length;
                i += chunkSize
            ) {

                const chunk =
                    data.substring(i, i + chunkSize);

                // SIMPLE SEARCH
                if (
                    chunk.toLowerCase().includes(
                        question.toLowerCase()
                    )
                ) {

                    relevantData += `

==================================================
FILE NAME: ${file}
==================================================

${chunk}

`;

                }

            }

        } catch (err) {

            console.log(err);

        }

    });

    return relevantData;

}



// =====================================================
// CHAT API
// =====================================================

app.post("/chat", async (req, res) => {

    try {

        const question = req.body.question;

        console.log("QUESTION:", question);



        // ==========================================
        // SEARCH RELEVANT CONTENT
        // ==========================================

        let context =
            searchKnowledge(question);



        // OPTIONAL: explain a specific uploaded file
        // (used by the Angular upload screen)
        const fileName = req.body.fileName;

        if (fileName) {

            const uploadedPath = path.join(
                knowledgePath,
                path.basename(fileName)
            );

            if (fs.existsSync(uploadedPath)) {

                const uploadedCode = fs
                    .readFileSync(uploadedPath, "utf8")
                    .substring(0, 12000);

                context =
`FILE NAME: ${path.basename(fileName)}

${uploadedCode}

` + context;

            }

        }



        if (context === "") {

            context =
                "Information not available in institutional database.";

        }



        // ==========================================
        // FINAL AI PROMPT
        // ==========================================

        const finalPrompt = `

You are an Advanced Embedded Systems AI Assistant.

STRICT RULES:
1. ONLY answer from institutional knowledge.
2. NEVER use internet knowledge.
3. If unavailable say:
   "Information not available in institutional database."

For EVERY answer provide:

1. Definition
2. Detailed Explanation
3. Why it is used
4. Importance
5. Working Principle
6. Code Explanation
7. Suggestions
8. Viva Questions
9. Real-time Applications
10. Step-by-step Flow

==================================================
INSTITUTIONAL KNOWLEDGE
==================================================

${context}

==================================================
USER QUESTION
==================================================

${question}

`;



        console.log("SENDING TO OLLAMA...");



        // ==========================================
        // OLLAMA REQUEST
        // ==========================================

        const response = await axios.post(
            "http://127.0.0.1:11434/api/generate",
            {
                model: "qwen2.5-coder:7b",
                prompt: finalPrompt,
                stream: false
            },
            {
                timeout: 120000
            }
        );



        console.log("AI RESPONSE RECEIVED");



        // ==========================================
        // SEND OUTPUT
        // ==========================================

        res.json({

            answer: response.data.response

        });

    } catch (error) {

        console.log(error.message);

        res.json({

            answer: "AI generation failed"

        });

    }

});



// =====================================================
// START SERVER
// =====================================================

app.listen(3000, () => {

    console.log("Server running on port 3000");

});