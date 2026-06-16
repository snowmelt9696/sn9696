import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import nodemailer from 'nodemailer';

function pickEmailConfig(config) {
  const email = config.email ?? {};
  return {
    host: process.env.QQ_MAIL_HOST || email.host || 'smtp.qq.com',
    port: Number(process.env.QQ_MAIL_PORT || email.port || 465),
    secure: String(process.env.QQ_MAIL_SECURE ?? email.secure ?? 'true') !== 'false',
    user: process.env.QQ_MAIL_USER || email.user,
    authCode: process.env.QQ_MAIL_AUTH_CODE || email.authCode,
    to: process.env.QQ_MAIL_TO || email.to,
    fromName: process.env.QQ_MAIL_FROM_NAME || email.fromName || '阿里云账单报告',
    attachJson: String(process.env.QQ_MAIL_ATTACH_JSON ?? email.attachJson ?? 'false') === 'true',
    detailPreviewLimit: Number(process.env.QQ_MAIL_DETAIL_PREVIEW_LIMIT || email.detailPreviewLimit || 20),
  };
}

function formatBalance(balance) {
  if (!balance) {
    return '未识别';
  }
  return `${balance.amount}（来源：${balance.source}）`;
}

function formatDetailRows(details, limit) {
  if (!details.length) {
    return '未抓取到抵扣明细。';
  }

  return details.slice(0, limit).map((row, index) => {
    const entries = Object.entries(row).filter(([key, value]) => key !== 'raw' && String(value ?? '').trim());
    const preview = entries.slice(0, 6).map(([key, value]) => `${key}: ${value}`).join(' | ');
    return `${index + 1}. ${preview}`;
  }).join('\n');
}

function formatApiErrors(errors, limit = 4) {
  if (!errors?.length) {
    return '无。';
  }

  return errors.slice(0, limit).map((error, index) => {
    const parts = [
      `${index + 1}. ${error.action || 'UnknownAction'}`,
      error.message ? `msg=${error.message}` : null,
      error.response?.Code ? `code=${error.response.Code}` : null,
      error.response?.Message ? `remote=${error.response.Message}` : null,
    ].filter(Boolean);
    return parts.join(' | ');
  }).join('\n');
}

export async function sendCouponEmail({ config, result, csvPath, couponsPath, jsonPath }) {
  const email = pickEmailConfig(config);
  if (!email.user || !email.authCode || !email.to) {
    throw new Error('邮件配置不完整：请设置 QQ_MAIL_USER、QQ_MAIL_AUTH_CODE、QQ_MAIL_TO 三个 GitHub Secrets。');
  }

  const transporter = nodemailer.createTransport({
    host: email.host,
    port: email.port,
    secure: email.secure,
    auth: {
      user: email.user,
      pass: email.authCode,
    },
  });

  const balanceText = formatBalance(result.balance);
  const couponCount = result.coupons?.length ?? 0;
  const detailsCount = result.deductionDetails.length;
  const previewRows = formatDetailRows(result.deductionDetails, email.detailPreviewLimit);
  const errorPreview = formatApiErrors(result.apiErrors);
  const warningText = result.apiErrors?.length ? `API 警告：${result.apiErrors.length} 条` : 'API 警告：无';
  const subject = `阿里云余额 ${balanceText}，优惠券 ${couponCount} 张`;
  const text = [
    `抓取时间：${result.crawledAt}`,
    `数据来源：${result.url}`,
    `账户余额：${balanceText}`,
    `可用优惠券：${couponCount} 张`,
    `抵扣明细：${detailsCount} 条`,
    warningText,
    '',
    'API 错误摘要：',
    errorPreview,
    '',
    `前 ${Math.min(detailsCount, email.detailPreviewLimit)} 条抵扣明细：`,
    previewRows,
    '',
    '完整优惠券、抵扣明细和原始错误见附件 JSON。',
  ].join('\n');

  const attachments = [];
  if (csvPath && existsSync(csvPath)) {
    attachments.push({ filename: basename(csvPath), path: csvPath });
  }
  if (couponsPath && existsSync(couponsPath)) {
    attachments.push({ filename: basename(couponsPath), path: couponsPath });
  }
  if (email.attachJson && jsonPath && existsSync(jsonPath)) {
    attachments.push({ filename: basename(jsonPath), path: jsonPath });
  }

  await transporter.sendMail({
    from: `"${email.fromName}" <${email.user}>`,
    to: email.to,
    subject,
    text,
    attachments,
  });
}
