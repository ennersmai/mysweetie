export default function Tos() {
  return (
    <section className="mx-auto max-w-4xl rounded-2xl border border-white/10 bg-white/5 p-8 shadow-xl backdrop-blur">
      <h1 className="mb-4 text-3xl font-semibold text-white">Privacy Policy – MySweetie.AI</h1>
      <p className="mb-6 text-sm text-gray-300">Last updated: {new Date().toLocaleDateString()}</p>

      <div className="space-y-8 text-white/90 leading-relaxed">
        <div className="text-gray-300">
          <p>
            At MySweetie.AI ("Service," "we," "us," "our"), we respect your privacy and are committed to protecting your personal information. This Privacy Policy explains how we collect, use, and safeguard your data.
          </p>
        </div>

        <div className="border-t border-white/10 pt-6"></div>

        <section>
          <h2 className="mb-4 text-xl font-medium text-white">1. Information We Collect</h2>
          <p className="mb-4">We may collect the following types of information:</p>
          
          <div className="space-y-4 ml-4">
            <div>
              <h3 className="font-medium text-white mb-2">a) Account & Contact Information</h3>
              <p>• Email address, username, password (when you register).</p>
            </div>
            
            <div>
              <h3 className="font-medium text-white mb-2">b) Payment Information</h3>
              <p>• Payments are processed securely by third-party providers such as Stripe.</p>
              <p>• We do not store full credit/debit card numbers on our servers.</p>
            </div>
            
            <div>
              <h3 className="font-medium text-white mb-2">c) Usage Data</h3>
              <p>• Information about how you use the Service (e.g., pages visited, features used, interactions with AI characters).</p>
            </div>
            
            <div>
              <h3 className="font-medium text-white mb-2">d) Device & Technical Data</h3>
              <p>• Browser type, operating system, IP address, and cookies to improve user experience.</p>
            </div>
          </div>
        </section>

        <div className="border-t border-white/10 pt-6"></div>

        <section>
          <h2 className="mb-4 text-xl font-medium text-white">2. How We Use Your Information</h2>
          <p className="mb-3">We use your data to:</p>
          <div className="space-y-1 ml-4">
            <p>• Provide and maintain the Service.</p>
            <p>• Process payments and subscriptions.</p>
            <p>• Personalize your experience (e.g., saving AI characters you build).</p>
            <p>• Send important updates (e.g., subscription reminders, policy changes).</p>
            <p>• Improve site performance and prevent fraud or abuse.</p>
          </div>
        </section>

        <div className="border-t border-white/10 pt-6"></div>

        <section>
          <h2 className="mb-4 text-xl font-medium text-white">3. Sharing of Information</h2>
          <p className="mb-3">We do not sell or rent your personal information.</p>
          <p className="mb-3">We may share data with trusted third parties only when necessary to:</p>
          <div className="space-y-1 ml-4">
            <p>• Process payments (Stripe, payment gateways).</p>
            <p>• Provide hosting, analytics, or security services.</p>
            <p>• Comply with legal obligations.</p>
          </div>
        </section>

        <div className="border-t border-white/10 pt-6"></div>

        <section>
          <h2 className="mb-4 text-xl font-medium text-white">4. Data Retention</h2>
          <div className="space-y-1 ml-4">
            <p>• We retain account data while your subscription is active.</p>
            <p>• You may request deletion of your account and associated data at any time.</p>
            <p>• Certain transaction records may be retained as required by law (e.g., financial records).</p>
          </div>
        </section>

        <div className="border-t border-white/10 pt-6"></div>

        <section>
          <h2 className="mb-4 text-xl font-medium text-white">5. Cookies & Tracking</h2>
          <div className="space-y-1 ml-4">
            <p>• We use cookies and similar technologies to remember your preferences and improve site performance.</p>
            <p>• You may disable cookies in your browser, but some features may not function properly.</p>
          </div>
        </section>

        <div className="border-t border-white/10 pt-6"></div>

        <section>
          <h2 className="mb-4 text-xl font-medium text-white">6. Your Rights (GDPR & Global Compliance)</h2>
          <p className="mb-3">Depending on your location, you may have the right to:</p>
          <div className="space-y-1 ml-4">
            <p>• Access, correct, or delete your personal data.</p>
            <p>• Request data portability.</p>
            <p>• Withdraw consent for certain data uses.</p>
            <p>• File a complaint with your local data protection authority.</p>
          </div>
        </section>

        <div className="border-t border-white/10 pt-6"></div>

        <section>
          <h2 className="mb-4 text-xl font-medium text-white">7. Security</h2>
          <div className="space-y-1 ml-4">
            <p>• We use industry-standard measures (encryption, secure hosting, access controls) to protect your data.</p>
            <p>• However, no online service can guarantee 100% security.</p>
          </div>
        </section>

        <div className="border-t border-white/10 pt-6"></div>

        <section>
          <h2 className="mb-4 text-xl font-medium text-white">8. Children's Privacy</h2>
          <p className="mb-3 font-medium text-white">This Service is strictly for adults 18+ only.</p>
          <p>We do not knowingly collect data from anyone under 18. If we discover such data, it will be deleted immediately.</p>
        </section>

        <div className="border-t border-white/10 pt-6"></div>

        <section>
          <h2 className="mb-4 text-xl font-medium text-white">9. Changes to This Policy</h2>
          <p>We may update this Privacy Policy from time to time. Any changes will be posted on this page with the updated date.</p>
        </section>

        <div className="border-t border-white/10 pt-6"></div>

        <section>
          <h2 className="mb-4 text-xl font-medium text-white">10. Contact Us</h2>
          <p>
            For questions or concerns about this Privacy Policy, contact us at:{' '}
            <a href="mailto:support@mysweetie.ai" className="text-pink-400 hover:text-pink-300 underline">
              support@mysweetie.ai
            </a>
          </p>
        </section>
      </div>
    </section>
  );
}


