const { initializeQuestionSource } = await import("./question-source.js");
await initializeQuestionSource();
await import("./detector-compat.js");
await import("./app.js");
