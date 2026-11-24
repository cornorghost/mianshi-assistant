const fs = require('node:fs');
class Credentials {
  constructor(file, safeStorage) { this.file=file; this.storage=safeStorage; }
  key() {
    if (fs.existsSync(this.file)) {
      if (!this.storage.isEncryptionAvailable()) throw new Error('系统密钥加密暂不可用');
      return this.storage.decryptString(fs.readFileSync(this.file));
    }
    return process.env.DASHSCOPE_API_KEY || '';
  }
  status() { return { configured:fs.existsSync(this.file) || !!process.env.DASHSCOPE_API_KEY }; }
  save(key) {
    if (!this.storage.isEncryptionAvailable()) throw new Error('系统密钥加密暂不可用，未保存密钥');
    key = String(key).trim();
    if (!/^sk-[a-zA-Z0-9_-]{8,}$/.test(key)) throw new Error('请填写有效的百炼 API Key（sk- 开头）');
    fs.writeFileSync(this.file + '.tmp',this.storage.encryptString(key)); fs.renameSync(this.file + '.tmp',this.file);
    return this.status();
  }
}
module.exports = { Credentials };
