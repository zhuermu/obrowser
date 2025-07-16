const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class SimpleStore {
  constructor(options = {}) {
    this.name = options.name || 'config';
    this.defaults = options.defaults || {};
    
    // 获取用户数据目录
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, `${this.name}.json`);
    
    // 确保目录存在
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    
    // 加载现有数据或创建默认数据
    this.data = this.loadData();
  }
  
  loadData() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        return { ...this.defaults, ...JSON.parse(data) };
      }
    } catch (error) {
      console.warn('Failed to load store data:', error);
    }
    return { ...this.defaults };
  }
  
  saveData() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('Failed to save store data:', error);
    }
  }
  
  get(key, defaultValue) {
    if (key === undefined) {
      return this.data;
    }
    
    const keys = key.split('.');
    let value = this.data;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue;
      }
    }
    
    return value;
  }
  
  set(key, value) {
    if (typeof key === 'object') {
      // 批量设置
      Object.assign(this.data, key);
    } else {
      const keys = key.split('.');
      let current = this.data;
      
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (!(k in current) || typeof current[k] !== 'object') {
          current[k] = {};
        }
        current = current[k];
      }
      
      current[keys[keys.length - 1]] = value;
    }
    
    this.saveData();
  }
  
  delete(key) {
    const keys = key.split('.');
    let current = this.data;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in current) || typeof current[k] !== 'object') {
        return;
      }
      current = current[k];
    }
    
    delete current[keys[keys.length - 1]];
    this.saveData();
  }
  
  clear() {
    this.data = { ...this.defaults };
    this.saveData();
  }
  
  has(key) {
    return this.get(key) !== undefined;
  }
}

module.exports = SimpleStore;
