export interface EmailTemplateData {
  appName?: string
  userName?: string
  userEmail?: string
  timestamp?: string
  environment?: string
  [key: string]: any
}

export interface EmailTemplate {
  subject: string
  html: (data: EmailTemplateData) => string
  text: (data: EmailTemplateData) => string
}

const baseStyles = {
  container: 'font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;',
  header: 'background: linear-gradient(135deg, #000000 0%, #374151 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; text-align: center;',
  content: 'background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;',
  footer: 'text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;',
  infoBox: 'background: #f3f4f6; border-left: 4px solid #000000; padding: 15px; margin: 20px 0; border-radius: 0 5px 5px 0;',
  button: 'background: #000000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;'
}

function buildEmailTemplate(
  subject: string,
  htmlContent: (data: EmailTemplateData) => string,
  textContent: (data: EmailTemplateData) => string
): EmailTemplate {
  return {
    subject,
    html: (data: EmailTemplateData) => `
      <div style="${baseStyles.container}">
        <div style="${baseStyles.header}">
          <h1 style="margin: 0; font-size: 24px;">${data.appName || 'App'}</h1>
          <p style="margin: 10px 0 0 0; opacity: 0.9;">${subject}</p>
        </div>
        <div style="${baseStyles.content}">
          ${htmlContent(data)}
        </div>
      </div>
    `,
    text: textContent
  }
}

export const testEmailTemplate: EmailTemplate = buildEmailTemplate(
  'Test Email',
  data => `
    <h2 style="color: #333; margin-top: 0;">Hello ${data.userName || 'User'}!</h2>
    <p style="color: #666; line-height: 1.6;">
      This is a test email from ${data.appName || 'the application'}. If you're receiving this,
      the email system is working correctly.
    </p>
    <div style="${baseStyles.infoBox}">
      <h3 style="margin: 0 0 10px 0; color: #333;">Email Details:</h3>
      <ul style="margin: 0; color: #666;">
        <li><strong>Sent to:</strong> ${data.userEmail || 'Unknown'}</li>
        <li><strong>Timestamp:</strong> ${data.timestamp || 'Unknown'}</li>
        <li><strong>Environment:</strong> ${data.environment || 'Unknown'}</li>
      </ul>
    </div>
  `,
  data => `Test Email from ${data.appName || 'App'}\n\nHello ${data.userName || 'User'}!\n\nThis is a test email. The email system is working correctly.\n\nSent to: ${data.userEmail || 'Unknown'}\nTimestamp: ${data.timestamp || 'Unknown'}\nEnvironment: ${data.environment || 'Unknown'}`
)

export const welcomeEmailTemplate: EmailTemplate = buildEmailTemplate(
  'Welcome!',
  data => `
    <h2 style="color: #333; margin-top: 0;">Welcome ${data.userName || 'User'}!</h2>
    <p style="color: #666; line-height: 1.6;">
      Thank you for joining ${data.appName || 'us'}! We're excited to have you on board.
    </p>
    <p style="color: #666; line-height: 1.6;">
      If you have any questions or run into any issues, don't hesitate to reach out.
    </p>
  `,
  data => `Welcome to ${data.appName || 'App'}!\n\nHello ${data.userName || 'User'}!\n\nThank you for joining. We're excited to have you on board.`
)

export const notificationEmailTemplate: EmailTemplate = buildEmailTemplate(
  'New Notification',
  data => `
    <h2 style="color: #333; margin-top: 0;">Hello ${data.userName || 'User'}!</h2>
    <p style="color: #666; line-height: 1.6;">
      You have a new notification from ${data.appName || 'the application'}.
    </p>
    <div style="${baseStyles.infoBox}">
      <p style="margin: 0; color: #666;">${data.message || 'No message provided'}</p>
    </div>
    ${data.actionUrl
      ? `
    <div style="text-align: center; margin-top: 30px;">
      <a href="${data.actionUrl}" style="${baseStyles.button}">
        ${data.actionText || 'View Details'}
      </a>
    </div>
    `
      : ''}
  `,
  data => `New Notification from ${data.appName || 'App'}\n\nHello ${data.userName || 'User'}!\n\n${data.message || 'No message provided'}\n\n${data.actionUrl ? `${data.actionText || 'View Details'}: ${data.actionUrl}` : ''}`
)

export const bulkEmailTemplate: EmailTemplate = buildEmailTemplate(
  'Admin Message',
  data => `
    <h2 style="color: #333; margin-top: 0;">Hello ${data.userName || 'User'}!</h2>
    <div style="color: #666; line-height: 1.6;">
      ${data.message || 'No message provided'}
    </div>
    ${data.actionUrl
      ? `
    <div style="text-align: center; margin-top: 30px;">
      <a href="${data.actionUrl}" style="${baseStyles.button}">
        ${data.actionText || 'Learn More'}
      </a>
    </div>
    `
      : ''}
  `,
  data => `Admin Message from ${data.appName || 'App'}\n\nHello ${data.userName || 'User'}!\n\n${data.message || 'No message provided'}`
)

export const verificationEmailTemplate: EmailTemplate = buildEmailTemplate(
  'Verify Your Email Address',
  data => `
    <h2 style="color: #333; margin-top: 0;">Hello ${data.userName || 'User'}!</h2>
    <p style="color: #666; line-height: 1.6;">
      Thank you for registering with ${data.appName || 'us'}! To complete your registration,
      please verify your email address by clicking the button below.
    </p>
    <div style="text-align: center; margin-top: 30px;">
      <a href="${data.verificationUrl || '#'}" style="${baseStyles.button}">
        Verify Email Address
      </a>
    </div>
    <p style="color: #666; line-height: 1.6; margin-top: 20px; font-size: 14px;">
      If the button doesn't work, copy and paste this link into your browser:
      <br>
      <a href="${data.verificationUrl || '#'}" style="color: #000000; text-decoration: underline; word-break: break-all;">
        ${data.verificationUrl || '#'}
      </a>
    </p>
    <p style="color: #666; line-height: 1.6; margin-top: 20px; font-size: 14px;">
      This link will expire in 24 hours. If you didn't create an account,
      you can safely ignore this email.
    </p>
  `,
  data => `Verify Your Email Address - ${data.appName || 'App'}\n\nHello ${data.userName || 'User'}!\n\nPlease verify your email by visiting:\n\n${data.verificationUrl || '#'}\n\nThis link will expire in 24 hours.`
)

export const emailChangeVerificationTemplate: EmailTemplate = buildEmailTemplate(
  'Confirm Your New Email Address',
  data => `
    <h2 style="color: #333; margin-top: 0;">Hello ${data.userName || 'User'}!</h2>
    <p style="color: #666; line-height: 1.6;">
      You requested to change your email address from <strong>${data.oldEmail || 'your current email'}</strong>
      to <strong>${data.newEmail || 'a new email'}</strong>.
    </p>
    <div style="text-align: center; margin-top: 30px;">
      <a href="${data.verificationUrl || '#'}" style="${baseStyles.button}">
        Confirm Email Change
      </a>
    </div>
    <p style="color: #666; line-height: 1.6; margin-top: 20px; font-size: 14px;">
      If the button doesn't work, copy and paste this link into your browser:
      <br>
      <a href="${data.verificationUrl || '#'}" style="color: #000000; text-decoration: underline; word-break: break-all;">
        ${data.verificationUrl || '#'}
      </a>
    </p>
    <p style="color: #666; line-height: 1.6; margin-top: 20px; font-size: 14px;">
      This link will expire in 24 hours. If you didn't request this change,
      you can safely ignore this email.
    </p>
  `,
  data => `Confirm Your New Email Address - ${data.appName || 'App'}\n\nHello ${data.userName || 'User'}!\n\nYou requested to change your email from ${data.oldEmail} to ${data.newEmail}.\n\nConfirm: ${data.verificationUrl || '#'}\n\nThis link will expire in 24 hours.`
)

export const inviteEmailTemplate: EmailTemplate = buildEmailTemplate(
  'You\'ve been invited',
  data => `
    <h2 style="color: #333; margin-top: 0;">Hello ${data.userName || 'there'}!</h2>
    <p style="color: #666; line-height: 1.6;">
      ${data.inviterName ? `${data.inviterName} has invited you` : 'You have been invited'}
      to join ${data.orgName || data.appName || 'the application'}.
    </p>
    <p style="color: #666; line-height: 1.6;">
      Click the button below to accept the invitation and set up your account.
    </p>
    <div style="text-align: center; margin-top: 30px;">
      <a href="${data.inviteUrl || '#'}" style="${baseStyles.button}">
        Accept Invitation
      </a>
    </div>
    <p style="color: #666; line-height: 1.6; margin-top: 20px; font-size: 14px;">
      If the button doesn't work, copy and paste this link into your browser:
      <br>
      <a href="${data.inviteUrl || '#'}" style="color: #000000; text-decoration: underline; word-break: break-all;">
        ${data.inviteUrl || '#'}
      </a>
    </p>
    <p style="color: #666; line-height: 1.6; margin-top: 20px; font-size: 14px;">
      This invitation will expire in 7 days. If you weren't expecting this email,
      you can safely ignore it.
    </p>
  `,
  data => `You've been invited to ${data.orgName || data.appName || 'the application'}\n\nHello ${data.userName || 'there'}!\n\n${data.inviterName ? `${data.inviterName} has invited you` : 'You have been invited'} to join ${data.orgName || data.appName || 'the application'}.\n\nAccept your invitation: ${data.inviteUrl || '#'}\n\nThis invitation will expire in 7 days.`
)

export const passwordResetEmailTemplate: EmailTemplate = buildEmailTemplate(
  'Reset Your Password',
  data => `
    <h2 style="color: #333; margin-top: 0;">Hello ${data.userName || 'User'}!</h2>
    <p style="color: #666; line-height: 1.6;">
      You requested to reset your password for your ${data.appName || ''} account.
    </p>
    <div style="text-align: center; margin-top: 30px;">
      <a href="${data.resetUrl || '#'}" style="${baseStyles.button}">
        Reset Password
      </a>
    </div>
    <p style="color: #666; line-height: 1.6; margin-top: 20px; font-size: 14px;">
      If the button doesn't work, copy and paste this link into your browser:
      <br>
      <a href="${data.resetUrl || '#'}" style="color: #000000; text-decoration: underline; word-break: break-all;">
        ${data.resetUrl || '#'}
      </a>
    </p>
    <p style="color: #666; line-height: 1.6; margin-top: 20px; font-size: 14px;">
      This link will expire in 1 hour. If you didn't request a password reset,
      you can safely ignore this email.
    </p>
  `,
  data => `Reset Your Password - ${data.appName || 'App'}\n\nHello ${data.userName || 'User'}!\n\nReset your password: ${data.resetUrl || '#'}\n\nThis link will expire in 1 hour.`
)

export const emailTemplates = {
  test: testEmailTemplate,
  welcome: welcomeEmailTemplate,
  notification: notificationEmailTemplate,
  bulk: bulkEmailTemplate,
  verification: verificationEmailTemplate,
  emailChangeVerification: emailChangeVerificationTemplate,
  passwordReset: passwordResetEmailTemplate,
  invite: inviteEmailTemplate
}

export function renderEmailTemplate(
  templateName: keyof typeof emailTemplates,
  data: EmailTemplateData
): { subject: string, html: string, text: string } {
  const template = emailTemplates[templateName]
  if (!template) {
    throw new Error(`Email template '${templateName}' not found`)
  }
  return {
    subject: template.subject,
    html: template.html(data),
    text: template.text(data)
  }
}
