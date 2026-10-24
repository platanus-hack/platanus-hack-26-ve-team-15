---
name: rag-ai-pipeline
description: Plug-and-play Retrieval-Augmented Generation (RAG) and LLM pipeline patterns. Covers vector indexing, context chunking, prompt assembly, and streaming responses.
metadata:
  origin: curated-hackathon
---

# Skill: RAG & Multi-Modal AI Pipeline

Guides the implementation of AI features (RAG, agentic tools, vision, speech, streaming) in hackathons.

## Pipeline Architecture:
```text
User Query ──> Embedding ──> Vector Search (Top-K) ──> Prompt Assembly ──> LLM Stream ──> Client UI
```

## Key Guidelines:
1. **Semantic Chunking**:
   - Keep chunks between 300 - 600 tokens with 10% overlap.
   - Attach metadata (`file`, `title`, `category`) to each chunk for filtering.
2. **Context Compression**:
   - Do NOT pass all retrieved chunks blindly into the context window.
   - Filter by similarity threshold ($\ge 0.75$) to avoid wasting tokens and diluting answer quality.
3. **Streaming First**:
   - Real-time token streaming gives users an immediate perception of extreme speed.
   - Use Server-Sent Events (SSE) or WebSockets for live token delivery.
4. **Fallback Handling**:
   - If an API provider rate-limits or fails, automatically fallback to a secondary model tier.
