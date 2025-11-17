
import React, { useState, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { PredictionResult, PeriodRecord } from './types';
import { CalendarIcon, CloseIcon } from './components/Icons';
import CalendarModal from './components/CalendarModal';

// Timezone-safe date formatting
const formatDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const App: React.FC = () => {
  const [records, setRecords] = useState<PeriodRecord[]>(() => {
    try {
      const savedRecords = localStorage.getItem('periodRecords');
      if (!savedRecords) return [];
      const parsed = JSON.parse(savedRecords);
      if (Array.isArray(parsed) && (parsed.length === 0 || (typeof parsed[0] === 'object' && parsed[0].startDate))) {
          return parsed.map((r: any) => ({id: r.id || r.startDate, startDate: r.startDate}));
      }
      return [];
    } catch (error) {
      console.error("Failed to parse records from localStorage", error);
      return [];
    }
  });

  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [geminiAnalysis, setGeminiAnalysis] = useState<string | null>(null);
  const [predictionModel, setPredictionModel] = useState<'simple' | 'weighted'>('simple');
  const [defaultCycleLength, setDefaultCycleLength] = useState<number>(() => {
    const savedDefault = localStorage.getItem('defaultCycleLength');
    return savedDefault ? parseInt(savedDefault, 10) : 28;
  });

  useEffect(() => {
    localStorage.setItem('periodRecords', JSON.stringify(records));
  }, [records]);

  useEffect(() => {
    localStorage.setItem('defaultCycleLength', defaultCycleLength.toString());
  }, [defaultCycleLength]);
  
  const fetchGeminiAnalysis = async (currentPrediction: PredictionResult) => {
    if (!process.env.API_KEY) {
        setGeminiAnalysis("AI分析服务未配置。");
        return;
    }
    setIsAiLoading(true);
    setGeminiAnalysis(null);

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const { stats } = currentPrediction;
        const prompt = `作为一名女性健康顾问，请根据以下月经周期数据，为用户生成一份简短的中文周期报告（约100-150字）。报告应包括对周期稳定性的评估、一些普遍的健康建议，并以友好和积极的口吻结尾。强调这些信息不能替代专业医疗意见。\n\n周期数据：平均周期 ${stats.average} 天, 最短 ${stats.shortest}, 最长 ${stats.longest}。`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        setGeminiAnalysis(response.text);
    } catch (error) {
        console.error("Error fetching health suggestions:", error);
        setGeminiAnalysis("抱歉，AI报告服务暂时无法使用。请稍后再试。");
    } finally {
        setIsAiLoading(false);
    }
  };

  const handleSaveDates = (dates: string[]) => {
    const sortedDates = dates.sort((a,b) => new Date(a).getTime() - new Date(b).getTime());
    const newRecords = sortedDates.map(d => ({ id: d, startDate: d }));
    setRecords(newRecords);
    setIsCalendarOpen(false);
  };
  
  const handleDeleteRecord = (id: string) => {
    setRecords(records.filter(r => r.id !== id));
  };

  const handlePredict = () => {
    setIsLoading(true);
    setError(null);
    setPrediction(null);
    setGeminiAnalysis(null);
    
    const sortedRecords = [...records].sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

    if (sortedRecords.length < 1) {
      setError('请至少选择一个经期开始日期。');
      setIsLoading(false);
      return;
    }

    if (sortedRecords.length < 2) {
      if (defaultCycleLength > 0 && sortedRecords.length === 1) {
        const lastDate = new Date(sortedRecords[0].startDate + 'T00:00:00');
        const predictedDate = new Date(lastDate);
        predictedDate.setDate(predictedDate.getDate() + defaultCycleLength);

        const rangeStart = new Date(predictedDate);
        rangeStart.setDate(rangeStart.getDate() - 3); // Default range
        const rangeEnd = new Date(predictedDate);
        rangeEnd.setDate(rangeEnd.getDate() + 3);

        const newPrediction: PredictionResult = {
          stats: { average: defaultCycleLength, shortest: defaultCycleLength, longest: defaultCycleLength },
          predictedDate: formatDate(predictedDate),
          rangeStart: formatDate(rangeStart),
          rangeEnd: formatDate(rangeEnd),
          cycleLengths: [],
        };
        setPrediction(newPrediction);
        fetchGeminiAnalysis(newPrediction);
        setIsLoading(false);
        return;
      } else {
        setError('请至少选择两个经期开始日期，或设置一个默认周期长度并选择一个开始日期。');
        setIsLoading(false);
        return;
      }
    }
    
    const validDates = sortedRecords.map(r => new Date(r.startDate + 'T00:00:00'));

    const cycleLengths: number[] = [];
    for (let i = 1; i < validDates.length; i++) {
      const diffTime = Math.abs(validDates[i].getTime() - validDates[i-1].getTime());
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
      cycleLengths.push(diffDays);
    }
    
    if (cycleLengths.length === 0) {
      setError('无法计算周期长度，请检查输入的日期。');
      setIsLoading(false);
      return;
    }

    let predictionAverage: number;
    if (predictionModel === 'weighted' && cycleLengths.length > 1) {
        let weightedSum = 0;
        let weightSum = 0;
        for (let i = 0; i < cycleLengths.length; i++) {
            const weight = i + 1; // Increasing weight for more recent cycles
            weightedSum += cycleLengths[i] * weight;
            weightSum += weight;
        }
        predictionAverage = Math.round(weightedSum / weightSum);
    } else {
        const totalDays = cycleLengths.reduce((sum, length) => sum + length, 0);
        predictionAverage = Math.round(totalDays / cycleLengths.length);
    }

    const totalDays = cycleLengths.reduce((sum, length) => sum + length, 0);
    const average = Math.round(totalDays / cycleLengths.length);
    const shortest = Math.min(...cycleLengths);
    const longest = Math.max(...cycleLengths);

    const lastDate = validDates[validDates.length - 1];
    const predictedDate = new Date(lastDate);
    predictedDate.setDate(predictedDate.getDate() + predictionAverage);

    const variability = Math.round((longest - shortest) / 2);
    const delta = Math.max(1, Math.min(7, variability));

    const rangeStart = new Date(predictedDate);
    rangeStart.setDate(rangeStart.getDate() - delta);
    const rangeEnd = new Date(predictedDate);
    rangeEnd.setDate(rangeEnd.getDate() + delta);

    const newPrediction: PredictionResult = {
      stats: { average, shortest, longest },
      predictedDate: formatDate(predictedDate),
      rangeStart: formatDate(rangeStart),
      rangeEnd: formatDate(rangeEnd),
      cycleLengths,
    };

    setPrediction(newPrediction);
    fetchGeminiAnalysis(newPrediction);
    setIsLoading(false);
  };
  
  const chartData = prediction && prediction.cycleLengths.length > 0 ? prediction.cycleLengths.map((length, index) => ({
    name: `周期 ${index + 1}`,
    '长度(天)': length,
    '平均长度': prediction.stats.average,
  })) : [];

  const calculateStats = (): { average: number; shortest: number; longest: number; } | null => {
      if (records.length < 2) return null;
      const validDates = records.map(r => new Date(r.startDate + 'T00:00:00')).sort((a,b) => a.getTime() - b.getTime());
      const cycleLengths: number[] = [];
      for (let i = 1; i < validDates.length; i++) {
        const diffTime = Math.abs(validDates[i].getTime() - validDates[i-1].getTime());
        const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
        cycleLengths.push(diffDays);
      }
      if (cycleLengths.length === 0) return null;
      const totalDays = cycleLengths.reduce((sum, length) => sum + length, 0);
      const average = Math.round(totalDays / cycleLengths.length);
      const shortest = Math.min(...cycleLengths);
      const longest = Math.max(...cycleLengths);
      return { average, shortest, longest };
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 py-8 px-4 sm:px-6 lg:px-8 font-sans">
      <main className="max-w-xl mx-auto space-y-8">
        <header className="flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-800">经期预测</h1>
          <button onClick={() => setIsCalendarOpen(true)} className="p-2 rounded-full hover:bg-gray-200" aria-label="选择日期">
            <CalendarIcon className="w-6 h-6 text-gray-600"/>
          </button>
        </header>

        <section className="p-6 bg-white rounded-2xl shadow-md">
          <h2 className="text-lg font-semibold text-gray-700 mb-4">历史经期记录</h2>
          <div className="flex flex-wrap gap-2 mb-4">
              {records.length > 0 ? records.sort((a,b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()).map(r => (
                  <div key={r.id} className="flex items-center bg-pink-100 text-pink-800 text-sm font-medium pl-3 pr-2 py-1 rounded-full">
                      <span>{r.startDate}</span>
                      <button onClick={() => handleDeleteRecord(r.id)} className="ml-2 text-pink-600 hover:text-pink-800">
                        <CloseIcon className="w-4 h-4" />
                      </button>
                  </div>
              )) : <p className="text-sm text-gray-500">点击下方按钮或日历图标添加记录。</p>}
          </div>
          <button onClick={() => setIsCalendarOpen(true)} className="w-full py-2 px-4 border-2 border-dashed border-gray-300 text-gray-500 rounded-lg hover:bg-gray-100 hover:border-gray-400 transition-colors">
            + 添加/编辑日期
          </button>
          
          <h3 className="text-md font-semibold text-gray-600 mt-6 mb-2 text-center">预测模型选择</h3>
            <div className="flex items-center justify-center space-x-6 bg-gray-50 p-3 rounded-lg">
                <label className="flex items-center cursor-pointer">
                    <input type="radio" name="model" value="simple" checked={predictionModel === 'simple'} onChange={() => setPredictionModel('simple')} className="h-4 w-4 text-pink-600 border-gray-300 focus:ring-pink-500" />
                    <span className="ml-2 text-sm text-gray-700">简单平均</span>
                </label>
                <label className="flex items-center cursor-pointer">
                    <input type="radio" name="model" value="weighted" checked={predictionModel === 'weighted'} onChange={() => setPredictionModel('weighted')} className="h-4 w-4 text-pink-600 border-gray-300 focus:ring-pink-500" />
                    <span className="ml-2 text-sm text-gray-700">加权平均 (近期优先)</span>
                </label>
            </div>

           <button
            onClick={handlePredict}
            disabled={isLoading || records.length < 1}
            className="w-full mt-6 py-3 px-4 bg-pink-500 text-white font-semibold rounded-lg transition-all hover:bg-pink-600 disabled:bg-pink-300 disabled:cursor-not-allowed shadow-md"
          >
            {isLoading ? '正在计算...' : '开始预测'}
          </button>
          {error && <p className="text-red-500 mt-3 text-center text-sm">{error}</p>}
        </section>

        {prediction && (
          <div className="space-y-6 animate-fade-in">
            <div className="p-6 bg-white rounded-2xl shadow-md text-center">
              <h2 className="text-lg font-semibold text-gray-700 mb-1">下一次经期预测</h2>
               <p className="text-xs text-gray-500 mb-2">
                使用 <span className="font-semibold">{predictionModel === 'simple' ? '简单平均' : '加权平均'}</span> 模型
              </p>
              <p className="text-gray-500 text-sm">最可能日期</p>
              <p className="text-5xl font-bold text-pink-500 my-3">{prediction.predictedDate}</p>
              <p className="text-sm text-gray-600 bg-gray-100 inline-block px-3 py-1 rounded-full">{`预测范围: ${prediction.rangeStart} ~ ${prediction.rangeEnd}`}</p>
            </div>
            
            {chartData.length > 0 && (
                <div className="p-6 bg-white rounded-2xl shadow-md">
                    <h2 className="text-lg font-semibold text-gray-700 mb-4">周期分析</h2>
                     <div style={{ width: '100%', height: 200 }} className="mb-6">
                        <ResponsiveContainer>
                            <LineChart data={chartData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis dataKey="name" fontSize={12} />
                                <YAxis domain={['dataMin - 2', 'dataMax + 2']} fontSize={12} />
                                <Tooltip />
                                <Legend wrapperStyle={{fontSize: "14px"}} />
                                <Line type="monotone" dataKey="长度(天)" stroke="#ec4899" strokeWidth={2} activeDot={{ r: 8 }} />
                                <Line type="monotone" dataKey="平均长度" stroke="#8884d8" strokeDasharray="5 5" />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>

                  <ul className="space-y-4 text-base">
                    <li>
                      <div className="flex justify-between items-center"><span>平均周期长度</span><strong className="font-semibold bg-pink-100 text-pink-800 px-2 py-0.5 rounded">{prediction.stats.average} 天</strong></div>
                      <p className="text-xs text-gray-500 mt-1 pl-1">根据您历史周期的平均天数计算得出，是预测未来周期的重要依据。</p>
                    </li>
                    <li>
                      <div className="flex justify-between items-center"><span>最短周期</span><strong className="font-medium bg-gray-100 px-2 py-0.5 rounded">{prediction.stats.shortest} 天</strong></div>
                       <p className="text-xs text-gray-500 mt-1 pl-1">您记录的最短的一次周期长度，了解周期波动范围有助健康管理。</p>
                    </li>
                     <li>
                      <div className="flex justify-between items-center"><span>最长周期</span><strong className="font-medium bg-gray-100 px-2 py-0.5 rounded">{prediction.stats.longest} 天</strong></div>
                       <p className="text-xs text-gray-500 mt-1 pl-1">您记录的最长的一次周期长度，与最短周期一同反映您周期的规律性。</p>
                    </li>
                  </ul>
                </div>
            )}
            
            <div className="p-6 bg-white rounded-2xl shadow-md">
                 <h2 className="text-lg font-semibold text-gray-700 mb-4">AI 周期报告</h2>
                {isAiLoading && <p className="text-sm text-gray-500 animate-pulse">AI 报告生成中，请稍候...</p>}
                {geminiAnalysis && (
                    <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap">{geminiAnalysis}</div>
                )}
            </div>
          </div>
        )}
        
        <footer className="text-center pt-4">
            <p className="text-xs text-gray-400">所有计算均在您的浏览器中完成，您的数据不会被发送到任何服务器。</p>
        </footer>
      </main>
      
      <CalendarModal 
        isOpen={isCalendarOpen} 
        onClose={() => setIsCalendarOpen(false)} 
        onSave={handleSaveDates}
        initialDates={records.map(r => r.startDate)}
        stats={calculateStats()}
        defaultCycleLength={defaultCycleLength}
        onSetDefault={setDefaultCycleLength}
      />
    </div>
  );
};

export default App;
