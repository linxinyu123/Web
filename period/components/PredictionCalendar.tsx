import React, { useState, useMemo } from 'react';
import type { PeriodRecord, PredictionResult } from '../types';

const formatDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

interface PredictionCalendarProps {
  records: PeriodRecord[];
  prediction: PredictionResult;
}

const PredictionCalendar: React.FC<PredictionCalendarProps> = ({ records, prediction }) => {
  const [currentDate, setCurrentDate] = useState(new Date());

  const { historicalDates, futurePredictions } = useMemo(() => {
    const historicalDates = new Set(records.map(r => r.startDate));
    const futurePredictions = new Map<string, { range: Set<string> }>();

    if (prediction) {
      const { stats } = prediction;
      const sortedRecords = [...records].sort((a,b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
      
      const variability = Math.round((stats.longest - stats.shortest) / 2);
      const delta = Math.max(1, Math.min(7, variability));

      let lastDate = new Date(sortedRecords[sortedRecords.length - 1].startDate + 'T00:00:00');
      
      for (let i = 0; i < 12; i++) {
        const predictedDate = new Date(lastDate);
        predictedDate.setDate(predictedDate.getDate() + (stats.average * (i + 1)));
        
        const predictedDateStr = formatDate(predictedDate);
        const range = new Set<string>();
        
        for (let d = -delta; d <= delta; d++) {
            const rangeDate = new Date(predictedDate);
            rangeDate.setDate(rangeDate.getDate() + d);
            range.add(formatDate(rangeDate));
        }
        futurePredictions.set(predictedDateStr, { range });
      }
    }
    return { historicalDates, futurePredictions };
  }, [records, prediction]);
  
  const changeMonth = (offset: number) => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + offset, 1));
  };
  
  const renderCalendar = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const days = [];
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="w-10 h-10"></div>);
    }

    for (let i = 1; i <= daysInMonth; i++) {
      const dateStr = formatDate(new Date(year, month, i, 12));
      const isHistorical = historicalDates.has(dateStr);
      
      let isPredicted = false;
      let isInRange = false;

      // FIX: Iterate directly over the 'futurePredictions' map to avoid potential type inference issues with an intermediate array.
      for (const [predictedDateStr, { range }] of futurePredictions) {
          if (range.has(dateStr)) {
              isInRange = true;
          }
          if (predictedDateStr === dateStr) {
              isPredicted = true;
          }
      }
      
      let dayClass = 'w-10 h-10 rounded-full transition-colors flex items-center justify-center';
      if (isHistorical) {
          dayClass += ' bg-pink-500 text-white';
      } else if (isPredicted) {
          dayClass += ' bg-pink-400 text-white font-bold';
      } else if (isInRange) {
          dayClass += ' bg-pink-100';
      }

      days.push(
        <div key={i} className="flex items-center justify-center">
          <div className={dayClass}>
            {i}
          </div>
        </div>
      );
    }
    return days;
  };

  return (
    <div className="p-6 bg-white rounded-2xl shadow-md">
        <h2 className="text-lg font-semibold text-gray-700">预测日历</h2>
        <div className="p-4 border-b">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">{`${currentDate.getFullYear()} 年 ${currentDate.getMonth() + 1} 月`}</h3>
                <div className="flex items-center space-x-2">
                    <button onClick={() => changeMonth(-1)} className="p-1 rounded-full hover:bg-gray-100">&lt;</button>
                    <button onClick={() => changeMonth(1)} className="p-1 rounded-full hover:bg-gray-100">&gt;</button>
                </div>
            </div>
             <div className="grid grid-cols-7 text-center text-sm text-gray-500">
                {['日', '一', '二', '三', '四', '五', '六'].map(day => <div key={day}>{day}</div>)}
            </div>
        </div>
        <div className="p-4 grid grid-cols-7 gap-y-2">{renderCalendar()}</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 justify-center pt-2 border-t">
            <div className="flex items-center"><div className="w-3 h-3 rounded-full bg-pink-500 mr-2"></div>记录日</div>
            <div className="flex items-center"><div className="w-3 h-3 rounded-full bg-pink-400 mr-2"></div>预测日</div>
            <div className="flex items-center"><div className="w-3 h-3 rounded-full bg-pink-100 mr-2"></div>预测范围</div>
        </div>
    </div>
  );
};

export default PredictionCalendar;