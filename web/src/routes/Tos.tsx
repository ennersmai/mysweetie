export default function Tos() {
  return (
    <section className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-white/5 p-8 shadow-xl backdrop-blur">
      <h1 className="mb-4 text-3xl font-semibold text-white">Terms of Service</h1>
      <p className="mb-6 text-sm text-gray-300">Last updated: {new Date().toLocaleDateString()}</p>

      <div className="space-y-6 text-white/90">
        <section>
          <h2 className="mb-2 text-lg font-medium text-white">1. Acceptance of Terms</h2>
          <p>
            By accessing or using sweetie.ai (the “Service”), you agree to be bound by these Terms of Service. If you
            do not agree, do not use the Service.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium text-white">2. Age Requirement</h2>
          <p>
            The Service is intended for adults only. By creating an account or using the Service, you represent and
            warrant that you are at least 18 years of age (or the age of majority in your jurisdiction). All characters
            depicted within the Service are fictional adults (18+) and any roleplay or interactions are intended solely
            for adult audiences.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium text-white">3. Accounts</h2>
          <p>
            You are responsible for maintaining the confidentiality of your account and for all activities under your
            account. You must be at least 18 years old to use the Service.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium text-white">4. Subscriptions</h2>
          <p>
            Paid plans are billed via Stripe. Subscriptions renew automatically until canceled. Changes to pricing will
            be communicated in advance where required.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium text-white">5. User Content</h2>
          <p>
            You retain ownership of your content. You grant us a limited license to process content for the purpose of
            providing the Service, including AI responses and voice synthesis.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium text-white">6. Acceptable Use</h2>
          <p>
            Do not use the Service for illegal activities, harassment, or content that violates applicable laws or
            third-party rights.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium text-white">7. Disclaimer</h2>
          <p>
            The Service is provided “as is” without warranties of any kind. We do not guarantee availability,
            uninterrupted operation, or error-free performance.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium text-white">8. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, we shall not be liable for any indirect, incidental, special, or
            consequential damages arising from your use of the Service.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium text-white">9. Changes</h2>
          <p>
            We may update these Terms from time to time. Continued use constitutes acceptance of the revised Terms.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-medium text-white">10. Contact</h2>
          <p>
            Questions about these Terms? Contact support at support@mysweetie.ai.
          </p>
        </section>
      </div>
    </section>
  );
}


