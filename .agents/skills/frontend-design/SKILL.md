---
name: frontend-design
description: Modern aesthetic UI/UX playbook for high-impact hackathon demos. Guides the creation of sleek dark modes, glassmorphism, modern typography, vibrant gradients, and micro-interactions.
metadata:
  origin: curated-hackathon
---

# Skill: Modern Frontend Design & Visual Polish

In hackathons, judges evaluate with their eyes first. A generic, plain-looking MVP gets forgotten; a polished, responsive, vibrant application commands attention.

## Visual Design Principles:
1. **Curated Color Palettes**:
   - Background: Sleek obsidian/slate darks (`#0a0d14`, `#0f172a`, `#18181b`).
   - Card Surfaces: Semi-transparent glassmorphism with subtle borders (`backdrop-blur-md bg-white/5 border border-white/10`).
   - Accents: Vibrant, harmonious glows (cyan `#06b6d4`, electric violet `#8b5cf6`, or emerald `#10b981`).
2. **Typography**:
   - Use clean, modern sans fonts (Inter, Plus Jakarta Sans, Outfit, Geist).
   - Clear visual hierarchy: bold descriptive headings, muted metadata, readable line heights.
3. **Interactive Polish (Micro-Animations)**:
   - Hover transitions (`transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]`).
   - Loading spinners and shimmering skeletons rather than abrupt page jumps.
   - Dynamic toasts / feedback notifications on user actions.
4. **Hero Section Impact**:
   - Bold 1-sentence value proposition.
   - Interactive live preview or playground right above the fold.
   - Clear primary Call-to-Action (CTA).
