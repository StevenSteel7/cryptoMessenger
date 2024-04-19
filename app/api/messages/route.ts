import { NextResponse } from "next/server";

import getCurrentUser from "@/app/actions/getCurrentUser";
import { pusherServer } from '@/app/libs/pusher'
import prisma from "@/app/libs/prismadb";
import { spawn } from "child_process";
const crypto = require('crypto');

export async function POST(
  request: Request,
) {
  try {
    let encryptedMessage = '';
    const currentUser = await getCurrentUser();
    const body = await request.json();
    const {
      message,
      image,
      conversationId
    } = body;

    if (!currentUser?.id || !currentUser?.email) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

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
    const encryptedMessagePromise = new Promise<string>((resolve, reject) => {
      const pythonProcess = spawn('python', ['./app/api/AES.py', masterKey, message, 'encrypt']);
      pythonProcess.stdout.on('data', (data) => {
        resolve(data.toString());
      });
      pythonProcess.stderr.on('data', (data) => {
        console.error(`Python stderr: ${data}`);
        reject(data.toString());
      });
    });

    try {
      // Wait for the encrypted message to be resolved
      const encryptedMessage = await encryptedMessagePromise;

      // Create the new message
      const newMessage = await prisma.message.create({
        include: {
          seen: true,
          sender: true
        },
        data: {
          body: encryptedMessage,
          image: image,
          conversation: {
            connect: { id: conversationId }
          },
          sender: {
            connect: { id: currentUser.id }
          },
          seen: {
            connect: {
              id: currentUser.id
            }
          },
        }
      });

      const updatedConversation = await prisma.conversation.update({
        where: {
          id: conversationId
        },
        data: {
          lastMessageAt: new Date(),
          messages: {
            connect: {
              id: newMessage.id
            }
          }
        },
        include: {
          users: true,
          messages: {
            include: {
              seen: true
            }
          }
        }
      });
      await decryptMessages(masterKey, [newMessage]);
      await pusherServer.trigger(conversationId, 'messages:new', newMessage);
  
      const lastMessage = updatedConversation.messages[updatedConversation.messages.length - 1];
  
      updatedConversation.users.map((user) => {
        pusherServer.trigger(user.email!, 'conversation:update', {
          id: conversationId,
          messages: [lastMessage]
        });
      });
  
      return NextResponse.json(newMessage)

      // Handle the creation of the message
    } catch (error) {
      // Handle errors
    }
  } catch (error) {
    console.log(error, 'ERROR_MESSAGES')
    return new NextResponse('Error', { status: 500 });
  }
}

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
    const pythonProcess = spawn('python', ['./app/api/AES.py', masterKey, encryptedMessage, 'decrypt']);
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
