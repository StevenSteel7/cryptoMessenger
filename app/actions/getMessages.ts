import prisma from "@/app/libs/prismadb";
import { spawn } from "child_process";
const crypto = require('crypto');

const getMessages = async (
  conversationId: string
) => {
  try {
    const messages = await prisma.message.findMany({
      where: {
        conversationId: conversationId
      },
      include: {
        sender: true,
        seen: true,
      },
      orderBy: {
        createdAt: 'asc'
      }
    });

    const hashedUser = await prisma.conversation.findUnique({
      where: {
        id: conversationId
      }
    });
    
    var userHash: string[] = [];
    if (hashedUser && hashedUser.userIds) {
      hashedUser.userIds.map((user) => {
        userHash.push(user);
      });
    }

      const concatenatedUserIDs = userHash.join('');

      // Hash concatenated user IDs using SHA-256
      const sha256Hash = crypto.createHash('sha256');
      sha256Hash.update(concatenatedUserIDs);
      const fullHash  = sha256Hash.digest();
      const truncatedHash = fullHash.slice(0, 16);

      // Convert the truncated hash to hexadecimal string
      let masterKey = truncatedHash.toString('hex');
      await decryptMessages(masterKey, messages);

    return messages;
  } catch (error: any) {
    return [];
  }
};

export default getMessages;

async function decryptMessages(masterKey: string, messages: any[]) {
  const decryptionPromises = messages.map(async (message) => {
    if (message.body !== null) {
      try {
        const decryptedMessage = await decryptMessage(masterKey, message.body);
        message.body = decryptedMessage;
      } catch (error) {
        console.error(`Error decrypting message: ${error}`);
      }
    }
  });

  await Promise.all(decryptionPromises);
}

async function decryptMessage(masterKey: string, encryptedMessage: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const pythonProcess = spawn('python', ['./app/libs/AES.py', masterKey, encryptedMessage, 'decrypt']);
    let decryptedMessage = '';
  
    pythonProcess.stdout.on('data', (data) => {
      decryptedMessage += data.toString(); // Append data to decrypted message
    });
  
    pythonProcess.stderr.on('data', (data) => {
      console.error(`Python stderr: ${data}`);
      reject(data.toString());
    });
  
    pythonProcess.on('close', (code) => {
      if (code === 0) {
        // Successfully decrypted the message
        resolve(decryptedMessage);
      } else {
        reject(`Failed to decrypt message. Exit code: ${code}`);
      }
    });
  });
}
