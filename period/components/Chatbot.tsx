
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Chat } from '@google/genai';
import { ChatIcon, CloseIcon, SendIcon } from './Icons';
import type { ChatMessage } from '../types';

if (!process.env.API_KEY) {
  // This is a placeholder for development. In a real environment, the key would be set.
  // The app will show an alert if the key is missing.
  console.warn("API_KEY environment variable not set. Chatbot will not function.");
}

const Chatbot: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(scrollToBottom, [messages]);

  const initializeChat = useCallback(() => {
    if(!process.env.API_KEY) {
      setError("AI功能未配置，无法使用。");
      return;
    }
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const chatSession = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction: '你是一个关于女性健康和月经周期的AI助手。请用中文友好地回答问题。你的知识是通用的，不能替代专业的医疗建议。',
        },
      });
      setChat(chatSession);
      setMessages([
          { role: 'model', content: '您好！我是您的健康助手，有什么关于经期或女性健康的问题都可以问我。' }
      ]);
    } catch (e) {
        console.error("Failed to initialize chat:", e);
        setError("初始化AI助手失败。");
    }
  }, []);

  useEffect(() => {
    if (isOpen && !chat) {
      initializeChat();
    }
  }, [isOpen, chat, initializeChat]);

  const handleSendMessage = async () => {
    if (!input.trim() || isLoading || !chat) return;

    const userMessage: ChatMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const stream = await chat.sendMessageStream({ message: input });
      setIsLoading(false);
      
      let modelResponse = '';
      setMessages(prev => [...prev, { role: 'model', content: '' }]);

      for await (const chunk of stream) {
        modelResponse += chunk.text;
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].content = modelResponse;
          return newMessages;
        });
      }
    } catch (e) {
      console.error("Chat error:", e);
      setMessages(prev => [...prev, { role: 'model', content: '抱歉，我暂时无法回答。请稍后再试。' }]);
      setIsLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 bg-pink-500 text-white p-4 rounded-full transition-all transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-pink-500 shadow-lg"
        aria-label="打开AI助手"
      >
        <ChatIcon className="w-8 h-8" />
      </button>

      {isOpen && (
        <div className="fixed bottom-0 right-0 sm:bottom-6 sm:right-6 w-full h-full sm:w-96 sm:h-[600px] bg-white rounded-none sm:rounded-2xl shadow-2xl flex flex-col transition-all duration-300 ease-out border border-gray-200">
          <header className="bg-pink-500 text-white p-4 flex justify-between items-center rounded-t-none sm:rounded-t-2xl">
            <h3 className="text-lg font-semibold">AI 助手</h3>
            <button onClick={() => setIsOpen(false)} className="hover:opacity-75">
              <CloseIcon className="w-6 h-6" />
            </button>
          </header>

          <div className="flex-1 p-4 overflow-y-auto bg-gray-50">
            {error && <div className="p-2 text-center text-red-600 bg-red-100 rounded-md">{error}</div>}
            {messages.map((msg, index) => (
              <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} mb-3`}>
                <div className={`max-w-xs md:max-w-sm px-4 py-2 rounded-2xl ${msg.role === 'user' ? 'bg-pink-200 text-gray-800 rounded-br-none' : 'bg-white text-gray-800 rounded-bl-none shadow-sm'}`}>
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ))}
             {isLoading && messages[messages.length-1].role === 'user' && (
                <div className="flex justify-start mb-3">
                    <div className="max-w-xs md:max-w-sm px-4 py-2 rounded-2xl bg-white text-gray-800 rounded-bl-none shadow-sm">
                        <div className="flex items-center space-x-2">
                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse"></div>
                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse delay-75"></div>
                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse delay-150"></div>
                        </div>
                    </div>
                </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="p-4 bg-white border-t border-gray-200 rounded-b-none sm:rounded-b-2xl">
            <div className="flex items-center space-x-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                placeholder="输入您的问题..."
                className="flex-1 px-4 py-2 bg-gray-100 text-gray-800 rounded-full transition-shadow duration-200 border border-transparent outline-none focus:ring-2 focus:ring-pink-400"
                disabled={isLoading || !!error}
              />
              <button
                onClick={handleSendMessage}
                disabled={isLoading || !input.trim() || !!error}
                className="bg-pink-500 text-white p-3 rounded-full transition-all hover:bg-pink-600 disabled:bg-pink-300 disabled:cursor-not-allowed shadow-md"
              >
                <SendIcon className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default Chatbot;
