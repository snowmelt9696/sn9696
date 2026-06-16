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
    detailPreviewLimit: Number(process.env.QQ_MAIL_DETAIL_PREVIEW_LIMIT || email.detailPreviewLimit || 10),
  };
}

function formatMoney(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatCycle(value) {
  if (!value) {
    return '本期';
  }
  const [year, month] = String(value).split('-');
  return year && month ? `${year}年${Number(month)}月` : String(value);
}

function summarizeDeductions(details) {
  return details.reduce((total, row) => total + Number(row.totalDeduct ?? row.couponDeduct ?? 0), 0);
}

function summarizeCycles(details) {
  const cycles = [...new Set(details.map((row) => row.billingCycle).filter(Boolean))];
  if (!cycles.length) {
    return '本期';
  }
  return cycles.map(formatCycle).join('、');
}

function formatDetailRows(details, limit) {
  if (!details.length) {
    return '本期暂无优惠券抵扣明细。';
  }

  return details.slice(0, limit).map((row, index) => {
    const itemName = row.itemName || '未知计费项';
    const amount = formatMoney(row.totalDeduct ?? row.couponDeduct);
    return `${index + 1}. ${itemName}：¥${amount}`;
  }).join('\n');
}

function formatCouponRows(coupons) {
  if (!coupons?.length) {
    return '暂无可用优惠券。';
  }

  return coupons.map((coupon, index) => {
    const name = coupon.name || '未命名优惠券';
    const balance = formatMoney(coupon.balance);
    const expiry = coupon.expiryTime ? coupon.expiryTime.slice(0, 10) : '无到期时间';
    return `${index + 1}. ${name}\n   剩余 ¥${balance}，到期 ${expiry}`;
  }).join('\n');
}

function formatApiErrors(errors, limit = 3) {
  if (!errors?.length) {
    return '';
  }

  return [
    '',
    'API 警告：',
    ...errors.slice(0, limit).map((error, index) => {
      const code = error.response?.Code ? ` (${error.response.Code})` : '';
      return `${index + 1}. ${error.action || 'UnknownAction'}${code}: ${error.message || error.response?.Message || '未知错误'}`;
    }),
  ].join('\n');
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

  const balance = formatMoney(result.balance?.amount);
  const coupons = result.coupons ?? [];
  const details = result.deductionDetails ?? [];
  const deductionTotal = formatMoney(summarizeDeductions(details));
  const cycleText = summarizeCycles(details);
  const detailLimit = Math.min(details.length, email.detailPreviewLimit);
  const subject = `阿里云优惠券日报：余额 ¥${balance}，${cycleText}抵扣 ¥${deductionTotal}`;
  const text = [
    '阿里云优惠券日报',
    `生成时间：${formatDateTime(result.crawledAt)}`,
    `统计周期：${cycleText}`,
    '',
    `优惠券余额：¥${balance}`,
    `可用优惠券：${coupons.length} 张`,
    `${cycleText}抵扣：¥${deductionTotal}`,
    `抵扣条目：${details.length} 条`,
    '',
    '可用优惠券',
    formatCouponRows(coupons),
    '',
    `抵扣明细${detailLimit ? `（前 ${detailLimit} 条）` : ''}`,
    formatDetailRows(details, email.detailPreviewLimit),
    formatApiErrors(result.apiErrors),
    '',
    'CSV 附件包含完整数据。',
  ].filter((line) => line !== '').join('\n');

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
