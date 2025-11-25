1. **准备阶段**
   - 打开文件，获取**文件总大小** (Size)。
2. **智能采样 (关键步骤)**
   - **如果是小文件 (<10KB)**：直接读取整个文件内容。
   - **如果是大文件 (≥10KB)**：只读取 **头、中、尾** 各 2KB (共6KB)，跳过中间的大部分数据以节省时间。
3. **第一轮哈希：算内容**
   - 使用 FNV-1a 算法，对刚才读取到的数据（全部或6KB片段）计算出一个初始哈希值。
4. **第二轮哈希：加大小 (防撞保险)**
   - **将“文件总大小”这个数字混入哈希计算中**。
   - *目的*：即使两个不同视频的头尾数据完全一样，只要文件大小差 1 个字节，最终的 Hash 也会彻底改变，极大降低冲突概率。
5. **输出结果**
   - 将计算出的 64位整数转换成 **16位十六进制字符串** (如 4a1f8b3d9e2c7a01)，并确保不足位数补零。
   - 关闭文件释放资源。

```js
import * as fs from 'fs/promises';
import { constants } from 'fs';

// 配置常量
const CONFIG = {
  THRESHOLD: 10 * 1024, // 10KB
  BLOCK_SIZE: 2 * 1024, // 2KB
};

/**
 * FNV-1a 64-bit 哈希算法实现 (纯 TS 版)
 * @param buffer 数据块
 * @param seed 初始种子 (可选)
 * @returns BigInt 形式的哈希值
 */
function fnv1a64(buffer: Buffer, seed: bigint = 0xcbf29ce484222325n): bigint {
  const FNV_PRIME = 0x100000001b3n;
  let hash = seed;

  for (let i = 0; i < buffer.length; i++) {
    // XOR
    hash ^= BigInt(buffer[i]);
    // Multiply (使用 BigInt 进行 64 位乘法，会自动处理溢出截断)
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }
  return hash;
}

/**
 * 计算文件的快速哈希 (Sampled Hash)
 * 算法：Head + Mid + Tail + FileSize -> FNV-1a_64 -> Hex String
 */
export async function calculateFastHash(filePath: string): Promise<string> {
  let fileHandle: fs.FileHandle | null = null;

  try {
    fileHandle = await fs.open(filePath, constants.O_RDONLY);
    const stat = await fileHandle.stat();
    const fileSize = stat.size;

    // 1. 初始化 Buffer 用于存放采样数据
    // 如果文件小，Buffer 就只有文件那么大；如果文件大，Buffer 为 3个块的大小
    let buffer: Buffer;

    if (fileSize < CONFIG.THRESHOLD) {
      // --- 分支 A: 小文件全量读取 ---
      buffer = Buffer.alloc(fileSize);
      await fileHandle.read(buffer, 0, fileSize, 0);
    } else {
      // --- 分支 B: 大文件采样读取 ---
      // 头部 + 中部 + 尾部
      buffer = Buffer.alloc(CONFIG.BLOCK_SIZE * 3);

      // 读取 Head
      await fileHandle.read(buffer, 0, CONFIG.BLOCK_SIZE, 0);

      // 读取 Mid
      const midOffset = Math.floor(fileSize / 2) - Math.floor(CONFIG.BLOCK_SIZE / 2);
      await fileHandle.read(buffer, CONFIG.BLOCK_SIZE, CONFIG.BLOCK_SIZE, midOffset);

      // 读取 Tail
      const tailOffset = fileSize - CONFIG.BLOCK_SIZE;
      await fileHandle.read(buffer, CONFIG.BLOCK_SIZE * 2, CONFIG.BLOCK_SIZE, tailOffset);
    }

    // 2. 计算内容的 Hash
    let hashVal = fnv1a64(buffer);

    // 3. 【核心步骤】将文件大小 (File Size) 混入 Hash
    // 即使两个视频采样的数据完全一致，大小不同也会导致 Hash 剧变
    // 将 fileSize 转为 8字节 Buffer 混入
    const sizeBuffer = Buffer.alloc(8);
    sizeBuffer.writeBigUInt64LE(BigInt(fileSize)); 
    hashVal = fnv1a64(sizeBuffer, hashVal);

    // 4. 输出 16 进制字符串 (16 chars)
    // toString(16) 可能会省略前导零，需要 padStart 补齐
    return hashVal.toString(16).padStart(16, '0');

  } catch (error) {
    console.error(`Hash calculation failed for: ${filePath}`, error);
    throw error;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

// --- 使用示例 ---
// (async () => {
//   const hash = await calculateFastHash('D:/Videos/test.mp4');
//   console.log('Short Hash:', hash); // 输出示例: "a1b2c3d4e5f60708"
// })();
```

