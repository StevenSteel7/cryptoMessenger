import { NextResponse } from "next/server";
import getCurrentUser from "@/app/actions/getCurrentUser";
import { pusherServer } from '@/app/libs/pusher'
import prisma from "@/app/libs/prismadb";
import { spawn } from "child_process";
const crypto = require('crypto');
interface IParams {
  conversationId?: string;
}

export async function POST(
  request: Request,
  { params }: { params: IParams }
) {
  try {
    const currentUser = await getCurrentUser();
    const {
      conversationId
    } = params;

    
    if (!currentUser?.id || !currentUser?.email) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    // Find existing conversation
    const conversation = await prisma.conversation.findUnique({
      where: {
        id: conversationId,
      },
      include: {
        messages: {
          include: {
            seen: true
          },
        },
        users: true,
      },
    });

    if (!conversation) {
      return new NextResponse('Invalid ID', { status: 400 });
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
    
    // Array to hold promises for all decryption operations
    const decryptionPromises: Promise<void>[] = [];
    
    // Decrypt each message in the conversation
    for (const message of conversation.messages) {
      if (message.body !== null) {
        // Decrypt the message
        const decryptionPromise = decryptMessage(masterKey, message.body)
          .then((decryptedMessage) => {
            // Update the decrypted message in the conversation
            conversation.messages[conversation.messages.indexOf(message)].body = decryptedMessage;
          })
          .catch((error) => {
            console.error('Failed to decrypt message:', error);
          });
          
        decryptionPromises.push(decryptionPromise);
      }
    }
    
    // Wait for all decryption promises to resolve
    await Promise.all(decryptionPromises);
      
    // Find last message
    const lastMessage = conversation.messages[conversation.messages.length - 1];

    if (!lastMessage) {
      return NextResponse.json(conversation);
    }

    // Update seen of last message
    const updatedMessage = await prisma.message.update({
      where: {
        id: lastMessage.id
      },
      include: {
        sender: true,
        seen: true,
      },
      data: {
        seen: {
          connect: {
            id: currentUser.id
          }
        }
      }
    });

    // Update all connections with new seen
    await pusherServer.trigger(currentUser.email, 'conversation:update', {
      id: conversationId,
      messages: [updatedMessage]
    });

    // If user has already seen the message, no need to go further
    if (lastMessage.seenIds.indexOf(currentUser.id) !== -1) {
      return NextResponse.json(conversation);
    }

    // Update last message seen
    await pusherServer.trigger(conversationId!, 'message:update', updatedMessage);

    return new NextResponse('Success');
  } catch (error) {
    console.log(error, 'ERROR_MESSAGES_SEEN')
    return new NextResponse('Error', { status: 500 });
  }
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
