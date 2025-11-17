
import React, { useState, useEffect } from 'react';
import type { CycleStats } from '../types';

const formatDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

interface CalendarModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (dates: string[]) => void;
  initialDates: string[];
  stats: CycleStats | null;
  defaultCycleLength: number;
  onSetDefault: (length: number) => void;
}

const CalendarModal: React.FC<CalendarModalProps> = ({ 
    isOpen, 
    onClose, 
    onSave, 
    initialDates,
    stats,
    defaultCycleLength,
    onSetDefault,
}) => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set(initialDates));
  const [defaultInput, setDefaultInput] = useState<string>(defaultCycleLength.toString());

  useEffect(() => {
    setSelectedDates(new Set(initialDates));
  }, [initialDates]);

  const handleDateClick = (date: string) => {
    const newSelection = new Set(selectedDates);
    if (newSelection.has(date)) {
      newSelection.delete(date);
    } else {
      newSelection.add(date);
    }
    setSelectedDates(newSelection);
  };

  const changeMonth = (offset: number) => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + offset, 1));
  };
  
  const handleSave = () => {
    onSave(Array.from(selectedDates).sort());
  }

  const handleSetDefault = () => {
      const newLength = parseInt(defaultInput, 10);
      if (!isNaN(newLength) && newLength > 0) {
          onSetDefault(newLength);
      }
  }

  const renderCalendar = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = formatDate(new Date());

    const days = [];
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="w-10 h-10"></div>);
    }
    for (let i = 1; i <= daysInMonth; i++) {
      const dateStr = formatDate(new Date(year, month, i, 12)); // Use midday to avoid TZ issues
      const isSelected = selectedDates.has(dateStr);
      const isToday = dateStr === today;
      days.push(
        <div key={i} className="flex items-center justify-center">
          <button
            onClick={() => handleDateClick(dateStr)}
            className={`w-10 h-10 rounded-full ${
              isSelected ? 'bg-pink-500 text-white' : isToday ? 'bg-pink-200' : 'hover:bg-gray-100'
            }`}
          >
            {i}
          </button>
        </div>
      );
    }
    return days;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
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
        <div className="p-4 border-t space-y-4">
            <div className="text-sm">
                <p className="text-gray-600">当前平均周期: <span className="font-semibold text-pink-600">{stats ? `${stats.average} 天` : '数据不足'}</span></p>
                <div className="flex items-center space-x-2 mt-2">
                    <input 
                        type="number"
                        value={defaultInput}
                        onChange={(e) => setDefaultInput(e.target.value)}
                        className="w-20 px-2 py-1 border rounded-md text-center"
                    />
                    <button onClick={handleSetDefault} className="px-3 py-1 text-xs rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300">设为默认周期</button>
                </div>
                <p className="text-xs text-gray-400 mt-1">当记录少于2条时，将使用默认周期进行预测。</p>
            </div>
            <div className="flex justify-end space-x-2">
                <button onClick={onClose} className="px-4 py-2 rounded-lg text-gray-600 bg-gray-100 hover:bg-gray-200">取消</button>
                <button onClick={handleSave} className="px-4 py-2 rounded-lg bg-pink-500 text-white hover:bg-pink-600">保存</button>
            </div>
        </div>
      </div>
    </div>
  );
};

export default CalendarModal;
