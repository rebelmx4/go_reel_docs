const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // 新增：用于计算哈希
const { setImmediate } = require('timers');

class FastDirectoryScanner {
    constructor(options = {}) {
        this.options = {
            maxConcurrency: 200,
            batchSize: 50,
            hashThreshold: 10 * 1024, // 10KB阈值
            hashSampleSize: 2 * 1024, // 2KB采样大小
            enableHash: false, // 是否启用哈希计算
            ...options
        };
        
        this.fileMap = new Map();
        this.filesByCreateTime = [];
        this.hashMap = new Map(); // 新增：存储文件哈希值
        this.duplicateFiles = new Map(); // 新增：存储重复文件
        this.totalFiles = 0;
        this.totalSize = 0;
        this.scanStartTime = 0;
        this.scanEndTime = 0;
        this.statTime = 0;
        this.sortTime = 0;
        this.hashTime = 0; // 新增：哈希计算总时间
        
        this.stats = {
            directoriesScanned: 0,
            filesScanned: 0,
            concurrentOperations: 0,
            maxConcurrent: 0,
            filesWithHash: 0, // 新增：计算哈希的文件数量
            duplicateCount: 0, // 新增：重复文件数量
            hashErrors: 0 // 新增：哈希计算错误数量
        };
    }

    /**
     * 高性能扫描主函数
     */
    async scanDirectory(rootDir) {
        console.log(`🚀🚀 开始高性能扫描目录: ${path.resolve(rootDir)}`);
        if (this.options.enableHash) {
            console.log(`🔢🔢 启用文件哈希计算 (阈值: ${this._formatFileSize(this.options.hashThreshold)})`);
        }
        this._resetStats();
        this.scanStartTime = Date.now();
        
        try {
            await this._scanWithConcurrencyQueue(rootDir, '');
            
            // 统计排序时间
            const sortStart = Date.now();
            this._sortFilesByCreateTime();
            this.sortTime = Date.now() - sortStart;
            
            this.scanEndTime = Date.now();
            
            this._printResults();
            return this._getScanResults();
            
        } catch (error) {
            console.error('扫描错误:', error);
            throw error;
        }
    }

    /**
     * 使用并发队列控制扫描
     */
    async _scanWithConcurrencyQueue(rootDir, relativePath) {
        const queue = [];
        let activePromises = 0;
        let resolveFinish;
        let rejectFinish;
        
        const finishPromise = new Promise((resolve, reject) => {
            resolveFinish = resolve;
            rejectFinish = reject;
        });
        
        const processQueue = async () => {
            while (queue.length > 0 && activePromises < this.options.maxConcurrency) {
                activePromises++;
                this.stats.concurrentOperations = activePromises;
                this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, activePromises);
                
                const task = queue.shift();
                task().finally(() => {
                    activePromises--;
                    processQueue();
                    
                    // 检查是否所有任务都完成
                    if (activePromises === 0 && queue.length === 0) {
                        resolveFinish();
                    }
                }).catch(rejectFinish);
            }
        };
        
        // 添加根目录任务
        queue.push(() => this._processDirectory(rootDir, '', queue));
        processQueue();
        
        // 等待所有任务完成
        await finishPromise;
    }

    async _processDirectory(currentPath, relativePath, queue) {
        try {
            const items = await fs.promises.readdir(currentPath, { withFileTypes: true });
            this.stats.directoriesScanned++;
            
            const fileStats = [];
            
            for (const item of items) {
                const itemRelativePath = path.join(relativePath, item.name);
                const itemFullPath = path.join(currentPath, item.name);
                
                if (item.isDirectory()) {
                    // 目录任务加入队列
                    queue.push(() => this._processDirectory(itemFullPath, itemRelativePath, queue));
                } else if (item.isFile()) {
                    fileStats.push({ itemFullPath, itemRelativePath });
                }
            }
            
            // 批量处理文件stat
            if (fileStats.length > 0) {
                await this._processFilesInBatches(fileStats);
            }
            
        } catch (error) {
            console.warn(`无法读取目录: ${currentPath}`, error.message);
        }
    }

    /**
     * 批量处理文件统计
     */
    async _processFilesInBatches(fileStats) {
        for (let i = 0; i < fileStats.length; i += this.options.batchSize) {
            const batch = fileStats.slice(i, i + this.options.batchSize);
            const promises = batch.map(({ itemFullPath, itemRelativePath }) => 
                this._getFileStat(itemFullPath, itemRelativePath)
            );
            
            await Promise.all(promises);
        }
    }

    async _getFileStat(fullPath, relativePath) {
        const statStart = Date.now();
        
        try {
            const stats = await fs.promises.stat(fullPath);
            const statTime = Date.now() - statStart;
            this.statTime += statTime;
            
            this._addFileInfo(relativePath, stats, statTime);
            this.stats.filesScanned++;
            
            // 如果启用哈希计算，则计算文件哈希
            if (this.options.enableHash) {
                await this._calculateFileHash(fullPath, relativePath, stats.size);
            }
            
        } catch (error) {
            console.warn(`无法获取文件信息: ${relativePath}`, error.message);
        }
    }

    /**
     * 新增：计算文件哈希
     */
    async _calculateFileHash(fullPath, relativePath, fileSize) {
        const hashStart = Date.now();
        
        try {
            let hash = '';
            
            if (fileSize <= this.options.hashThreshold) {
                // 小于等于10KB，直接读取整个文件计算哈希
                hash = await this._calculateFullHash(fullPath);
            } else {
                // 大于10KB，采样计算哈希
                hash = await this._calculateSampledHash(fullPath, fileSize);
            }
            
            const hashTime = Date.now() - hashStart;
            this.hashTime += hashTime;
            
            // 存储哈希结果
            this.hashMap.set(relativePath, {
                hash: hash,
                hashTime: hashTime,
                method: fileSize <= this.options.hashThreshold ? 'full' : 'sampled'
            });
            
            this.stats.filesWithHash++;
            
            // 检查重复文件
            this._checkDuplicateFiles(relativePath, hash);
            
        } catch (error) {
            console.warn(`计算文件哈希失败: ${relativePath}`, error.message);
            this.stats.hashErrors++;
        }
    }

    /**
     * 计算整个文件的哈希
     */
    async _calculateFullHash(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('md5');
            const stream = fs.createReadStream(filePath);
            
            stream.on('data', (data) => {
                hash.update(data);
            });
            
            stream.on('end', () => {
                resolve(hash.digest('hex'));
            });
            
            stream.on('error', reject);
        });
    }

    /**
     * 采样计算文件哈希（开始、中间、结尾各2KB）
     */
    async _calculateSampledHash(filePath, fileSize) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('md5');
            const sampleSize = this.options.hashSampleSize;
            
            // 计算采样位置
            const positions = [
                { start: 0, length: Math.min(sampleSize, fileSize) }, // 开头
                { 
                    start: Math.floor(fileSize / 2) - Math.floor(sampleSize / 2), 
                    length: sampleSize 
                }, // 中间
                { 
                    start: Math.max(0, fileSize - sampleSize), 
                    length: Math.min(sampleSize, fileSize) 
                } // 结尾
            ];
            
            let samplesProcessed = 0;
            
            positions.forEach((pos) => {
                if (pos.start >= fileSize) {
                    samplesProcessed++;
                    if (samplesProcessed === positions.length) {
                        resolve(hash.digest('hex'));
                    }
                    return;
                }
                
                const stream = fs.createReadStream(filePath, {
                    start: pos.start,
                    end: pos.start + pos.length - 1
                });
                
                stream.on('data', (data) => {
                    hash.update(data);
                });
                
                stream.on('end', () => {
                    samplesProcessed++;
                    if (samplesProcessed === positions.length) {
                        resolve(hash.digest('hex'));
                    }
                });
                
                stream.on('error', reject);
            });
        });
    }

    /**
     * 检查重复文件
     */
    _checkDuplicateFiles(filePath, hash) {
        if (!this.duplicateFiles.has(hash)) {
            this.duplicateFiles.set(hash, []);
        }
        
        const duplicateList = this.duplicateFiles.get(hash);
        duplicateList.push(filePath);
        
        if (duplicateList.length === 2) {
            // 第一次发现重复
            this.stats.duplicateCount += 2;
        } else if (duplicateList.length > 2) {
            // 后续重复
            this.stats.duplicateCount++;
        }
    }

    _addFileInfo(relativePath, stats, statTime) {
        const fileInfo = {
            path: relativePath,
            size: stats.size,
            createTime: stats.birthtime,
            modifyTime: stats.mtime,
            accessTime: stats.atime,
            statDuration: statTime
        };
        
        this.fileMap.set(relativePath, fileInfo);
        this.totalFiles++;
        this.totalSize += stats.size;
    }

    /**
     * 按创建时间排序文件（统计时间）
     */
    _sortFilesByCreateTime() {
        const filesArray = Array.from(this.fileMap.values());
        
        if (this.options.sortAlgorithm === 'quick') {
            this._quickSortByTime(filesArray);
        } else {
            filesArray.sort((a, b) => {
                return a.createTime.getTime() - b.createTime.getTime();
            });
        }
        
        this.filesByCreateTime = filesArray;
    }

    /**
     * 快速排序实现（可选）
     */
    _quickSortByTime(arr) {
        if (arr.length <= 1) return arr;
        
        const pivot = arr[Math.floor(arr.length / 2)];
        const left = [];
        const right = [];
        const equal = [];
        
        for (const file of arr) {
            const cmp = file.createTime.getTime() - pivot.createTime.getTime();
            if (cmp < 0) left.push(file);
            else if (cmp > 0) right.push(file);
            else equal.push(file);
        }
        
        return [...this._quickSortByTime(left), ...equal, ...this._quickSortByTime(right)];
    }

    /**
     * 获取扫描结果（包含哈希计算时间）
     */
    _getScanResults() {
        const scanDuration = this.scanEndTime - this.scanStartTime;
        const pureScanTime = scanDuration - this.sortTime;
        
        return {
            totalFiles: this.totalFiles,
            totalSize: this.totalSize,
            formattedTotalSize: this._formatFileSize(this.totalSize),
            scanDuration: `${scanDuration}ms`,
            scanDurationMs: scanDuration,
            pureScanTime: `${pureScanTime}ms`,
            pureScanTimeMs: pureScanTime,
            statTotalTime: `${this.statTime}ms`,
            statTotalTimeMs: this.statTime,
            sortTime: `${this.sortTime}ms`,
            sortTimeMs: this.sortTime,
            hashTime: `${this.hashTime}ms`, // 新增：哈希计算时间
            hashTimeMs: this.hashTime,
            averageStatTime: this.totalFiles > 0 ? `${(this.statTime / this.totalFiles).toFixed(2)}ms` : '0ms',
            averageSortTimePerFile: this.totalFiles > 0 ? `${(this.sortTime / this.totalFiles).toFixed(4)}ms` : '0ms',
            averageHashTime: this.stats.filesWithHash > 0 ? `${(this.hashTime / this.stats.filesWithHash).toFixed(2)}ms` : '0ms',
            stats: { ...this.stats }
        };
    }

    /**
     * 格式化文件大小
     */
    _formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const exponent = Math.floor(Math.log(bytes) / Math.log(1024));
        const size = (bytes / Math.pow(1024, exponent)).toFixed(2);
        
        return `${size} ${units[exponent]}`;
    }

    /**
     * 格式化时间
     */
    _formatTime(date) {
        if (!(date instanceof Date)) return '未知时间';
        
        return date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    /**
     * 重置统计信息
     */
    _resetStats() {
        this.fileMap.clear();
        this.filesByCreateTime = [];
        this.hashMap.clear();
        this.duplicateFiles.clear();
        this.totalFiles = 0;
        this.totalSize = 0;
        this.statTime = 0;
        this.sortTime = 0;
        this.hashTime = 0;
        this.stats = {
            directoriesScanned: 0,
            filesScanned: 0,
            concurrentOperations: 0,
            maxConcurrent: 0,
            filesWithHash: 0,
            duplicateCount: 0,
            hashErrors: 0
        };
    }

    /**
     * 打印扫描结果（包含哈希计算统计）
     */
    _printResults() {
        const results = this._getScanResults();
        
        console.log('\n' + '='.repeat(80));
        console.log('📊📊 高性能扫描结果（包含哈希计算统计）');
        console.log('='.repeat(80));
        
        console.log(`📁📁 扫描目录: ${process.cwd()}`);
        console.log(`📄📄 文件总数: ${results.totalFiles}`);
        console.log(`💾💾 总大小: ${results.formattedTotalSize}`);
        console.log(`⏱⏱⏱️  总耗时: ${results.scanDuration} (含排序)`);
        console.log(`🔍🔍 纯扫描耗时: ${results.pureScanTime} (不含排序)`);
        console.log(`📈📈 文件信息获取耗时: ${results.statTotalTime}`);
        console.log(`🔄🔄 排序耗时: ${results.sortTime}`);
        console.log(`🔢🔢 哈希计算耗时: ${results.hashTime}`);
        console.log(`📊📊 平均每个文件stat耗时: ${results.averageStatTime}`);
        console.log(`📊📊 平均每个文件排序耗时: ${results.averageSortTimePerFile}`);
        console.log(`🔢🔢 平均每个文件哈希计算耗时: ${results.averageHashTime}`);
        console.log(`🔄🔄 最大并发数: ${results.stats.maxConcurrent}`);
        console.log(`📁📁 扫描目录数: ${results.stats.directoriesScanned}`);
        
        if (this.options.enableHash) {
            console.log(`🔢🔢 计算哈希的文件数: ${this.stats.filesWithHash}`);
            console.log(`🔍🔍 发现重复文件数: ${this.stats.duplicateCount}`);
            console.log(`❌❌ 哈希计算错误数: ${this.stats.hashErrors}`);
            
            // 显示哈希计算性能分析
            this._printHashPerformance(results);
            
            // 显示重复文件信息
            // this._printDuplicateFiles();
        }
        
        if (this.filesByCreateTime.length > 0) {
            console.log(`🏷🏷️  最早创建文件: ${this._formatTime(this.filesByCreateTime[0].createTime)}`);
            console.log(`🏷🏷️  最晚创建文件: ${this._formatTime(this.filesByCreateTime[this.filesByCreateTime.length - 1].createTime)}`);
            
            this._printSortingPerformance();
        }
        
        console.log(`\n📋📋 前10个文件（按创建时间排序）:`);
        console.log('-'.repeat(90));
        console.log('创建时间 | 大小 | 文件路径');
        console.log('-'.repeat(90));
        
        this.filesByCreateTime.slice(0, 10).forEach((file, index) => {
            console.log(
                `${this._formatTime(file.createTime)} | ` +
                `${this._formatFileSize(file.size).padStart(8)} | ` +
                `${file.path}`
            );
        });
        
        this._printTimeDistribution();
    }

    /**
     * 新增：打印哈希计算性能分析
     */
    _printHashPerformance(results) {
        const hashPercentage = (results.hashTimeMs / results.scanDurationMs * 100).toFixed(2);
        const sampledFiles = Array.from(this.hashMap.values()).filter(h => h.method === 'sampled').length;
        const fullFiles = Array.from(this.hashMap.values()).filter(h => h.method === 'full').length;
        
        console.log(`\n⚡⚡ 哈希计算性能分析:`);
        console.log(`  哈希计算耗时占比: ${hashPercentage}%`);
        console.log(`  采样计算文件数: ${sampledFiles} (大于${this._formatFileSize(this.options.hashThreshold)})`);
        console.log(`  完整计算文件数: ${fullFiles} (小于等于${this._formatFileSize(this.options.hashThreshold)})`);
        console.log(`  哈希计算效率: ${(this.stats.filesWithHash / results.hashTimeMs * 1000).toFixed(0)} 文件/秒`);
        
        if (results.hashTimeMs > results.statTimeMs) {
            console.log(`  💡💡 提示: 哈希计算耗时较长，考虑调整采样策略或阈值`);
        } else {
            console.log(`  ✅ 哈希计算性能良好`);
        }
    }

    /**
     * 新增：打印重复文件信息
     */
    _printDuplicateFiles() {
        let duplicateGroups = 0;
        
        this.duplicateFiles.forEach((files, hash) => {
            if (files.length > 1) {
                duplicateGroups++;
                
                if (duplicateGroups <= 5) { // 只显示前5组重复文件
                    console.log(`\n🔍🔍 重复文件组 ${duplicateGroups} (哈希: ${hash.substring(0, 16)}...):`);
                    files.forEach((file, index) => {
                        const fileInfo = this.fileMap.get(file);
                        console.log(`  ${index + 1}. ${this._formatFileSize(fileInfo.size)} - ${file}`);
                    });
                }
            }
        });
        
        if (duplicateGroups > 5) {
            console.log(`  ... 还有 ${duplicateGroups - 5} 组重复文件未显示`);
        }
        
        if (duplicateGroups === 0) {
            console.log(`\n✅✅ 未发现重复文件`);
        }
    }

    /**
     * 打印排序性能分析
     */
    _printSortingPerformance() {
        const results = this._getScanResults();
        const sortPercentage = (results.sortTimeMs / results.scanDurationMs * 100).toFixed(2);
        
        console.log(`\n⚡⚡ 排序性能分析:`);
        console.log(`  排序耗时占比: ${sortPercentage}%`);
        console.log(`  排序算法: ${this.options.sortAlgorithm === 'quick' ? '快速排序' : '内置排序'}`);
        console.log(`  排序效率: ${(results.totalFiles / results.sortTimeMs * 1000).toFixed(0)} 文件/秒`);
        
        if (results.sortTimeMs > 100) {
            console.log(`  💡💡 提示: 排序耗时较长，考虑使用更高效的算法或减少排序数据量`);
        } else {
            console.log(`  ✅ 排序性能良好`);
        }
    }

    /**
     * 打印时间分布统计
     */
    _printTimeDistribution() {
        if (this.filesByCreateTime.length === 0) return;
        
        const timeGroups = {
            '今天': 0,
            '昨天': 0,
            '本周': 0,
            '本月': 0,
            '今年': 0,
            '更早': 0
        };
        
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - today.getDay());
        
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        
        this.filesByCreateTime.forEach(file => {
            const createTime = file.createTime;
            
            if (createTime >= today) {
                timeGroups['今天']++;
            } else if (createTime >= yesterday) {
                timeGroups['昨天']++;
            } else if (createTime >= startOfWeek) {
                timeGroups['本周']++;
            } else if (createTime >= startOfMonth) {
                timeGroups['本月']++;
            } else if (createTime >= startOfYear) {
                timeGroups['今年']++;
            } else {
                timeGroups['更早']++;
            }
        });
        
        console.log('\n📅📅 文件创建时间分布:');
        Object.entries(timeGroups).forEach(([period, count]) => {
            if (count > 0) {
                const percentage = ((count / this.totalFiles) * 100).toFixed(1);
                console.log(`  ${period}: ${count} 个文件 (${percentage}%)`);
            }
        });
    }

    /**
     * 获取特定时间范围的文件
     */
    getFilesByTimeRange(startTime, endTime) {
        const start = new Date(startTime).getTime();
        const end = new Date(endTime).getTime();
        
        return this.filesByCreateTime.filter(file => {
            const fileTime = file.createTime.getTime();
            return fileTime >= start && fileTime <= end;
        });
    }

    /**
     * 获取最大的文件
     */
    getLargestFiles(count = 10) {
        return Array.from(this.fileMap.values())
            .sort((a, b) => b.size - a.size)
            .slice(0, count)
            .map(file => ({
                ...file,
                formattedSize: this._formatFileSize(file.size)
            }));
    }

    /**
     * 新增：获取文件的哈希值
     */
    getFileHash(filePath) {
        return this.hashMap.get(filePath);
    }

    /**
     * 新增：获取所有重复文件
     */
    getAllDuplicateFiles() {
        const duplicates = [];
        
        this.duplicateFiles.forEach((files, hash) => {
            if (files.length > 1) {
                duplicates.push({
                    hash: hash,
                    files: files.map(file => ({
                        path: file,
                        size: this.fileMap.get(file).size,
                        formattedSize: this._formatFileSize(this.fileMap.get(file).size)
                    }))
                });
            }
        });
        
        return duplicates;
    }

    /**
     * 新增：根据哈希值查找文件
     */
    getFilesByHash(hash) {
        return this.duplicateFiles.get(hash) || [];
    }
}

// 使用示例
async function testHighPerformance() {
    const scanner = new FastDirectoryScanner({
        maxConcurrency: 100,
        batchSize: 50,
        enableHash: true, // 启用哈希计算
        hashThreshold: 10 * 1024, // 10KB阈值
        hashSampleSize: 2 * 1024, // 2KB采样大小
        // sortAlgorithm: 'quick'  // 可以启用快速排序测试
    });
    
    const testDir = 'd:/1_github';
    // const testDir = 'E:/100_MyProjects';

    
    if (fs.existsSync(testDir)) {
        console.log(`测试目录: ${testDir}`);
        await scanner.scanDirectory(testDir);
    } else {
        console.log(`测试目录不存在: ${testDir}`);
        console.log('使用当前目录进行测试...');
        await scanner.scanDirectory('./');
    }
    
    // 显示最大的文件
    const largestFiles = scanner.getLargestFiles(5);
    if (largestFiles.length > 0) {
        console.log('\n💾💾 最大的5个文件:');
        largestFiles.forEach((file, index) => {
            console.log(`  ${index + 1}. ${file.formattedSize} - ${file.path}`);
        });
    }
    
    // 显示重复文件统计
    const duplicates = scanner.getAllDuplicateFiles();
    if (duplicates.length > 0) {
        console.log(`\n🔍🔍 发现 ${duplicates.length} 组重复文件`);
    }
}

// 正确的运行方式
if (require.main === module) {
    testHighPerformance().catch(console.error);
} else {
    module.exports = FastDirectoryScanner;
}