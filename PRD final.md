Product Requirements Document (PRD): Premium AI Companion Chat Platform

    Version: 1.2 (Developer-Oriented)

    Status: Discovery Phase Concluded / Ready for Proof of Concept (POC)

    Author: Mai Dev (Maykal P.)

    Stakeholder: Daniel P. (Client)

1. Overview

This document details the technical requirements and architectural decisions for building a premium, adult-oriented AI chatbot website. The platform aims to offer an immersive conversational experience with unique AI companions, supported by robust monetization features and a highly scalable, modern tech stack. The focus is on a performant, cost-effective, and maintainable solution that can evolve into a full mobile application.
2. Technical Goals & Non-Functional Requirements

    Performance: Achieve fast response times for chat interactions (sub-second perceived latency).

    Scalability: Design for high user concurrency and the ability to scale to a large number of AI companions without significant re-architecture.

    Cost-Effectiveness: Utilize managed services and serverless components to optimize infrastructure costs, especially during early growth phases.

    Maintainability: Employ modern development practices, clear code organization, and a well-defined architecture to facilitate future development and debugging.

    Security: Implement secure authentication, payment processing (Stripe webhooks), and API key management.

    Extensibility: Build a foundation that allows for easy addition of new AI characters, voice providers, and future features (e.g., user-generated content, mobile app).

    User Experience (UX): Deliver a smooth, interactive, and visually appealing chat interface that feels responsive and intuitive.

3. Architectural Design

The platform will adopt a modern JAMstack-like architecture leveraging serverless functions for backend logic.

    Frontend (Vite/React): A highly interactive Single Page Application (SPA) providing the user interface.

    Backend Logic (Supabase Edge Functions): All core business logic, API orchestration (LLM, Voice, Stripe), and database interactions will reside in these functions for optimal performance and scalability.

    Database, Authentication, Storage (Supabase): A unified platform for data persistence, user management, and static asset storage.

    External APIs: Integration with specialized services for AI text generation, voice synthesis, and payments.

code Mermaid
IGNORE_WHEN_COPYING_START
IGNORE_WHEN_COPYING_END

      
graph TD
    A[User Browser/Mobile] -->|HTTP/S| B(Vite React Frontend on Vercel)
    B -->|API Calls| C(Supabase Edge Functions)
    C -->|Database Queries| D(Supabase PostgreSQL DB)
    C -->|Auth Calls| E(Supabase Auth)
    C -->|LLM API| F(OpenRouter API)
    C -->|Voice API| G(ElevenLabs / PlayHT API)
    C -->|Payment API| H(Stripe API)
    H -->|Webhooks| C
    B -->|File Fetch| I(Supabase Storage)

    

4. Core Features & Technical Implementation Details
4.1. F-01: User Authentication

    Description: Secure user signup and login to persist chat history and purchased content.

    Technical Details:

        Utilize Supabase Auth for all user management (email/password, potential social logins if deemed necessary later).

        Frontend will interact with Supabase client-side SDK for authentication flows.

        User sessions managed securely by Supabase.

4.2. F-02: AI Character Selection

    Description: Allow users to browse and select from a list of predefined AI companions.

    Technical Details:

        AI character metadata (name, description, avatar URL, initial system prompt) stored in a dedicated characters table in Supabase PostgreSQL.

        Frontend fetches character list from Supabase.

        Designed to scale easily; adding a new row in the characters table makes a new character available.

4.3. F-03: Core Chat Interface

    Description: A smooth, real-time, and highly responsive chat experience.

    Technical Details:

        Built with Vite + React for optimal rendering performance.

        Heavy client-side rendering (CSR) for fluidity.

        UI components styled with Tailwind CSS for rapid development and consistent design.

        Client-side message sending and display, with optimistic updates where appropriate.

4.4. F-04: AI Text Generation

    Description: AI companions generate text responses consistent with their personality and conversation context.

    Technical Details:

        Frontend sends user messages to a Supabase Edge Function endpoint (e.g., /api/chat).

        This Edge Function constructs the prompt for the LLM, including:

            The character's system prompt (from characters table).

            User-specific details for memory (see F-10).

            Conversation history (see F-10).

            User's current message.

        The Edge Function then calls the OpenRouter API to get the LLM's response.

        Error handling for API failures and rate limits.

4.5. F-05: AI Voice Playback

    Description: Hear AI responses spoken in unique voices.

    Technical Details:

        After text generation, the same Supabase Edge Function sends the generated text to the selected voice synthesis API (ElevenLabs or PlayHT).

        The Edge Function returns the audio URL (or base64 encoded audio) to the frontend.

        Playback Logic:

            Voice playback will be opt-in via a UI toggle/button.

            Once enabled by user interaction, subsequent voice messages will play automatically. This satisfies browser autoplay policies.

            Frontend will use HTML5 <audio> element or a dedicated audio library for playback.

        Discovery Phase Task: Finalize voice provider based on cost, quality, and API ease of use.

4.6. F-06: Freemium Paywall

    Description: Offer basic functionality for free, with premium features locked behind a paywall.

    Technical Details:

        User subscription status (e.g., is_premium: boolean or subscription_id: string) stored in the profiles table in Supabase DB.

        Supabase Edge Functions will check this status before:

            Calling premium LLMs via OpenRouter.

            Allowing unlimited voice generation requests.

            Granting access to locked content (F-08).

            Triggering Fantasy Mode (F-11).

        Frontend UI dynamically updates based on user's premium status, displaying "upgrade" prompts for locked features.

4.7. F-07: Stripe Recurring Billing

    Description: Enable secure, recurring monthly subscription payments.

    Technical Details:

        Supabase Edge Function acts as a backend endpoint for Stripe operations (e.g., /api/create-checkout-session).

        Frontend triggers this function when a user wants to subscribe.

        The Edge Function uses the Stripe API to:

            Create a Checkout Session for a recurring product (e.g., price_123).

            Redirect the user to Stripe's hosted checkout page.

        Stripe Webhooks: A dedicated Edge Function endpoint (e.g., /api/stripe-webhook) will receive events from Stripe (e.g., checkout.session.completed, customer.subscription.updated). This function will securely verify the webhook signature and update the user's is_premium status and subscription details in the Supabase DB.

4.8. F-08: Locked Content Gallery

    Description: Character-specific galleries with visual content, unlocked by premium status.

    Technical Details:

        Images stored securely in Supabase Storage buckets, with appropriate access policies.

        Gallery content (image URLs, descriptions) stored in a character_galleries table in Supabase DB.

        Display Logic:

            For free users, blurred or heavily watermarked previews of gallery images will be displayed. This requires client-side CSS filters or server-side image processing for previews.

            Upon premium access, the frontend will request the high-resolution, unblurred images directly from Supabase Storage.

        Access control checked by Supabase Edge Functions to ensure only premium users can request full-resolution assets.

4.9. F-09: Responsive Design

    Description: Ensure a flawless user experience across all device sizes (desktop, tablet, mobile).

    Technical Details:

        Developed with a mobile-first approach.

        Utilize Tailwind CSS responsive utility classes (sm:, md:, lg:, etc.).

        Thorough testing on various screen resolutions and device emulators.

4.10. F-10: Conversation Memory & Recall (Developer-Added Clarification)

    Description: AI companions remember user details (name, preferences) and conversation context for immersive interactions.

    Technical Details:

        Supabase DB (chat_history table): Store all messages exchanged in a conversation, linked to user_id and character_id.

        Supabase Edge Function Logic:

            When a new message is sent, the Edge Function retrieves a configurable N number of previous messages (e.g., 20) for the current conversation.

            This history, along with the character's system prompt and any known user details (e.g., from profiles table or a dedicated user_preferences table), is injected into the LLM prompt.

            Context Window Management: For very long conversations, strategies like summarization (using a smaller LLM) or token-aware truncation will be implemented to fit within the LLM's context window.

4.11. F-11: Fantasy Mode & Trigger Phrases (Developer-Added Clarification)

    Description: Premium users can trigger enhanced dialogue modes with specific phrases.

    Technical Details:

        Supabase Edge Function Logic:

            When a user sends a message, the Edge Function first checks if the user is is_premium.

            If premium, it parses the incoming user message for predefined "trigger phrases" (e.g., "activate fantasy mode").

            If a trigger phrase is detected, the Edge Function dynamically modifies the LLM's system prompt or adds specific instructions to guide the AI's response into the desired "Fantasy Mode" (e.g., "Now respond in a more seductive and explicit manner, focusing on descriptions of X").

        Trigger phrases and associated prompt modifications will be configurable (e.g., stored in a trigger_phrases table in Supabase).

4.12. F-12: Simplified Admin Character Management (Developer-Added Clarification)

    Description: Site owner can easily add new AI characters without code deployment.

    Technical Details:

        This will be managed directly via the Supabase Dashboard or a simple CLI/script for the MVP.

        New characters are added by inserting new rows into the characters table, specifying name, system_prompt, and avatar_url (from Supabase Storage).

        This approach avoids building a complex admin UI for MVP, focusing development resources on core user-facing features.

5. Technical Stack Breakdown & Rationale
Category	Technology	Description & Rationale
Frontend	Vite + React	Description: Modern JavaScript tooling for building fast SPAs. Vite offers incredibly fast cold starts and HMR (Hot Module Replacement) during development. React is a widely adopted library for building complex user interfaces. <br>Rationale: Provides an excellent developer experience and allows for building a highly interactive, client-side rendered chat application for a smooth user experience. Supports a component-based architecture for maintainability.
Styling	Tailwind CSS	Description: A utility-first CSS framework that enables rapid UI development by composing low-level utility classes directly in markup. <br>Rationale: Facilitates quick iteration on UI design, ensures consistency, and allows for highly customized, modern, and responsive designs without writing custom CSS.
Backend Logic	Supabase Edge Functions (Deno / TypeScript)	Description: Serverless functions written in TypeScript (powered by Deno) that run close to the user (at the "edge"). <br>Rationale: Primary choice for backend logic. Offers significant performance benefits due to global distribution, highly scalable, and extremely cost-effective (pay-per-invocation). Tightly integrated with the Supabase ecosystem (Auth, DB, Storage) for a cohesive developer experience and simplified deployment. TypeScript provides type safety and better maintainability.
Database, Auth, Storage	Supabase (PostgreSQL, Auth, Storage)	Description: An open-source Firebase alternative providing a fully managed PostgreSQL database, robust authentication, and file storage. <br>Rationale: Core data platform. Offers a powerful relational database (PostgreSQL) for structured data, out-of-the-box user authentication features (including social logins), and object storage for avatars and gallery content. Its real-time capabilities could be explored for future features. Reduces operational overhead significantly compared to self-hosting these components.
LLM Provider	OpenRouter	Description: An API gateway that provides access to a wide range of Large Language Models (LLMs) from various providers via a single API. <br>Rationale: Chosen for flexibility and cost. Allows dynamic switching between different LLMs based on cost, performance, and specific content needs (e.g., allowing NSFW models for adult content without jailbreaks). Offers competitive pricing and a unified interface, reducing vendor lock-in and allowing for easy experimentation or optimization later.
Voice Synthesis	ElevenLabs / PlayHT API	Description: AI services for generating high-quality, natural-sounding speech from text. <br>Rationale: To be finalized based on Discovery Phase research. Both offer high-quality voice output via API. The decision will hinge on balancing per-character costs, API rate limits, voice quality, and the ease of integration to find the most cost-effective and performant solution for recurring use.
Payments	Stripe	Description: Leading online payment processing platform for businesses. <br>Rationale: Industry standard for recurring billing. Provides robust APIs, hosted checkout pages, and webhooks essential for secure and reliable subscription management. Client already has an account set up.
Deployment	Vercel	Description: A cloud platform for static sites and Serverless Functions, optimized for frontend frameworks. <br>Rationale: Seamless deployment. Excellent integration with Vite/React for frontend hosting and automatically deploys Supabase Edge Functions. Provides global CDN for fast asset delivery, atomic deployments, and a simple Git-based workflow, simplifying the CI/CD pipeline.
6. Out of Scope for MVP

    Dedicated Admin UI: Character management will be direct via Supabase Dashboard/CLI for MVP.

    User-Created Characters: Focus remains on pre-defined, high-quality AI companions.

    Dedicated Mobile App (iOS/Android): Website will be mobile-optimized; native apps are a post-launch goal facilitated by the chosen tech stack (React + JavaScript/TypeScript backend).

    Complex Analytics Dashboard: Basic usage tracking can be implemented via Supabase or simple third-party integrations, but a custom dashboard is out of scope.

    Ad Slot Integration: Monetization is purely subscription-based for the MVP.

7. Next Steps

    Account Creation: Daniel to create necessary accounts for Voice Synthesis (finalized provider), OpenRouter, and provide access for integration.

    NDA: Ensure the Mutual NDA is signed by Mai Dev.

    Escrow: Daniel to fund the Proof of Concept (POC) phase escrow.

    Begin POC: Mai Dev will commence building the core features (F-01 to F-09 and F-10, F-11, F-12) as outlined. Regular updates will be provided.