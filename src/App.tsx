/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Upload, 
  BookOpen, 
  BrainCircuit, 
  Mail, 
  ChevronRight, 
  CheckCircle2, 
  XCircle, 
  RefreshCw,
  ArrowLeft,
  GraduationCap,
  LogIn,
  LogOut,
  History,
  Plus,
  Trash2,
  Github,
  FileText,
  FileUp,
  Sparkles
} from 'lucide-react';
import { useDropzone } from 'react-dropzone';
import * as mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';

// Set worker source for pdfjs
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  GithubAuthProvider,
  onAuthStateChanged, 
  signOut, 
  User 
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  serverTimestamp, 
  deleteDoc, 
  doc,
  getDocFromServer
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { generateQuiz, generateFlashcards, QuizQuestion, Flashcard } from './services/geminiService';
import { cn } from './lib/utils';

type Page = 'home' | 'quiz' | 'flashcards' | 'contact' | 'history';

interface StudySet {
  id: string;
  title: string;
  notes: string;
  quiz: QuizQuestion[];
  flashcards: Flashcard[];
  createdAt: any;
  uid: string;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('home');
  const [notes, setNotes] = useState('');
  const [title, setTitle] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [studySets, setStudySets] = useState<StudySet[]>([]);
  const [activeSet, setActiveSet] = useState<StudySet | null>(null);
  
  // Quiz State
  const [currentQuizIndex, setCurrentQuizIndex] = useState(0);
  const [quizScore, setQuizScore] = useState(0);
  const [quizFinished, setQuizFinished] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [isParsing, setIsParsing] = useState(false);

  // File Parsing Logic
  const extractTextFromFile = async (file: File): Promise<string> => {
    const extension = file.name.split('.').pop()?.toLowerCase();

    if (extension === 'txt') {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.readAsText(file);
      });
    }

    if (extension === 'docx') {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      return result.value;
    }

    if (extension === 'pdf') {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let fullText = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        fullText += pageText + '\n';
      }
      return fullText;
    }

    throw new Error('Unsupported file type');
  };

  const onDrop = async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    setIsParsing(true);
    try {
      const file = acceptedFiles[0];
      if (!title) setTitle(file.name.replace(/\.[^/.]+$/, ""));
      const text = await extractTextFromFile(file);
      setNotes(prev => prev ? prev + '\n\n' + text : text);
    } catch (error) {
      console.error('File parsing failed:', error);
    } finally {
      setIsParsing(false);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/plain': ['.txt'],
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
    },
    multiple: false
  });

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Firestore Connection Test
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    }
    testConnection();
  }, []);

  // Fetch Study Sets
  useEffect(() => {
    if (!user) {
      setStudySets([]);
      return;
    }

    const q = query(
      collection(db, 'studySets'),
      where('uid', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const sets: StudySet[] = [];
      snapshot.forEach((doc) => {
        sets.push({ id: doc.id, ...doc.data() } as StudySet);
      });
      setStudySets(sets.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
    }, (error) => {
      console.error("Firestore Error: ", error);
    });

    return () => unsubscribe();
  }, [user]);

  const handleLogin = async (providerType: 'google' | 'github' = 'google') => {
    const provider = providerType === 'google' ? new GoogleAuthProvider() : new GithubAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error(`${providerType} login failed:`, error);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setCurrentPage('home');
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  const handleGenerate = async () => {
    if (!notes.trim() || !user) return;
    setIsGenerating(true);
    try {
      const quizData = await generateQuiz(notes);
      const flashcardData = await generateFlashcards(notes);
      
      const newSet = {
        uid: user.uid,
        title: title || `Study Set ${new Date().toLocaleDateString()}`,
        notes,
        quiz: quizData,
        flashcards: flashcardData,
        createdAt: serverTimestamp(),
      };

      await addDoc(collection(db, 'studySets'), newSet);
      
      setCurrentPage('history');
      setNotes('');
      setTitle('');
    } catch (error) {
      console.error('Generation failed:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  const startQuiz = (set: StudySet) => {
    setActiveSet(set);
    setCurrentQuizIndex(0);
    setQuizScore(0);
    setQuizFinished(false);
    setSelectedOption(null);
    setIsCorrect(null);
    setCurrentPage('quiz');
  };

  const handleDeleteSet = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteDoc(doc(db, 'studySets', id));
    } catch (error) {
      console.error('Delete failed:', error);
    }
  };

  const handleQuizAnswer = (option: string) => {
    if (selectedOption || !activeSet) return;
    setSelectedOption(option);
    const correct = option === activeSet.quiz[currentQuizIndex].correctAnswer;
    setIsCorrect(correct);
    if (correct) setQuizScore(prev => prev + 1);
  };

  const nextQuestion = () => {
    if (!activeSet) return;
    if (currentQuizIndex + 1 < activeSet.quiz.length) {
      setCurrentQuizIndex(prev => prev + 1);
      setSelectedOption(null);
      setIsCorrect(null);
    } else {
      setQuizFinished(true);
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F5F5]">
        <RefreshCw className="animate-spin text-emerald-600" size={32} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F5F5] text-[#1A1A1A] font-sans selection:bg-emerald-100 flex flex-col">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-black/5">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div 
            className="flex items-center gap-2 cursor-pointer group"
            onClick={() => setCurrentPage('home')}
          >
            <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center text-white group-hover:rotate-12 transition-transform">
              <GraduationCap size={20} />
            </div>
            <span className="font-bold text-lg tracking-tight">NoteQuizzer</span>
          </div>
          <div className="flex items-center gap-6">
            <div className="hidden md:flex gap-8">
              <button 
                onClick={() => setCurrentPage('home')}
                className={cn("text-sm font-medium transition-colors", currentPage === 'home' ? "text-emerald-600" : "text-zinc-500 hover:text-zinc-900")}
              >
                Home
              </button>
              {user && (
                <button 
                  onClick={() => setCurrentPage('history')}
                  className={cn("text-sm font-medium transition-colors", currentPage === 'history' ? "text-emerald-600" : "text-zinc-500 hover:text-zinc-900")}
                >
                  My Library
                </button>
              )}
              <button 
                onClick={() => setCurrentPage('contact')}
                className={cn("text-sm font-medium transition-colors", currentPage === 'contact' ? "text-emerald-600" : "text-zinc-500 hover:text-zinc-900")}
              >
                Contact
              </button>
            </div>
            
            {user ? (
              <div className="flex items-center gap-4 pl-6 border-l border-black/5">
                <img src={user.photoURL || ''} alt="" className="w-8 h-8 rounded-full border border-black/5" />
                <button 
                  onClick={handleLogout}
                  className="p-2 text-zinc-400 hover:text-red-500 transition-colors"
                  title="Logout"
                >
                  <LogOut size={20} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => handleLogin('google')}
                  className="flex items-center gap-2 px-4 py-2 bg-white border border-zinc-200 text-zinc-900 rounded-xl text-sm font-semibold hover:bg-zinc-50 transition-all"
                >
                  <LogIn size={16} />
                  Google
                </button>
                <button 
                  onClick={() => handleLogin('github')}
                  className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-xl text-sm font-semibold hover:bg-zinc-800 transition-all"
                >
                  <Github size={16} />
                  GitHub
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-12 flex-grow w-full">
        <AnimatePresence mode="wait">
          {!user && currentPage === 'home' && (
            <motion.div
              key="landing"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="text-center space-y-12 py-20"
            >
              <div className="space-y-6 max-w-3xl mx-auto">
                <h1 className="text-7xl font-black tracking-tighter text-zinc-900 leading-[0.9]">
                  STUDY <span className="text-emerald-600">SMARTER</span><br/>NOT HARDER.
                </h1>
                <p className="text-xl text-zinc-500 max-w-xl mx-auto">
                  NoteQuizzer uses AI to transform your messy notes into structured study sets. Sign in to save your progress.
                </p>
                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                  <button 
                    onClick={() => handleLogin('google')}
                    className="px-10 py-5 bg-emerald-600 text-white rounded-2xl text-lg font-bold hover:bg-emerald-700 shadow-xl shadow-emerald-500/20 transition-all flex items-center justify-center gap-3"
                  >
                    Sign in with Google
                    <ChevronRight size={24} />
                  </button>
                  <button 
                    onClick={() => handleLogin('github')}
                    className="px-10 py-5 bg-zinc-900 text-white rounded-2xl text-lg font-bold hover:bg-zinc-800 shadow-xl shadow-zinc-500/20 transition-all flex items-center justify-center gap-3"
                  >
                    Sign in with GitHub
                    <Github size={24} />
                  </button>
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8 pt-12">
                {[
                  { icon: <BrainCircuit />, title: "AI Quizzes", desc: "Instant multiple choice questions." },
                  { icon: <BookOpen />, title: "Flashcards", desc: "Active recall made simple." },
                  { icon: <History />, title: "Cloud Sync", desc: "Access your notes anywhere." }
                ].map((f, i) => (
                  <div key={i} className="p-8 bg-white rounded-3xl border border-black/5 text-left space-y-4">
                    <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center">{f.icon}</div>
                    <h3 className="font-bold text-xl">{f.title}</h3>
                    <p className="text-zinc-500 text-sm leading-relaxed">{f.desc}</p>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {user && currentPage === 'home' && (
            <motion.div
              key="home"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-12"
            >
              <div className="flex justify-between items-end">
                <div className="space-y-2">
                  <h1 className="text-4xl font-bold tracking-tight text-zinc-900">
                    Welcome back, <span className="text-emerald-600">{user.displayName?.split(' ')[0]}</span>
                  </h1>
                  <p className="text-zinc-500">What are we studying today?</p>
                </div>
              </div>

              <div className="bg-white rounded-3xl p-8 shadow-sm border border-black/5 space-y-6">
                <div className="grid grid-cols-1 gap-6">
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">Set Title</label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="e.g., Biology Chapter 4: Photosynthesis"
                      className="w-full p-4 bg-zinc-50 border border-zinc-200 rounded-xl focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">Upload Files (PDF, DOCX, TXT)</label>
                      <div 
                        {...getRootProps()} 
                        className={cn(
                          "h-64 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-4 cursor-pointer transition-all",
                          isDragActive ? "border-emerald-500 bg-emerald-50" : "border-zinc-200 hover:border-emerald-400 hover:bg-zinc-50"
                        )}
                      >
                        <input {...getInputProps()} />
                        <div className="w-16 h-16 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center">
                          {isParsing ? <RefreshCw className="animate-spin" /> : <FileUp size={32} />}
                        </div>
                        <div className="text-center">
                          <p className="font-bold text-zinc-900">
                            {isDragActive ? "Drop it here!" : "Drag & drop file"}
                          </p>
                          <p className="text-xs text-zinc-500">or click to browse</p>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">Or Paste Notes</label>
                      <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Paste your notes here..."
                        className="w-full h-64 p-6 bg-zinc-50 border border-zinc-200 rounded-2xl focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all resize-none text-zinc-800 leading-relaxed"
                      />
                    </div>
                  </div>
                </div>

                <button
                  disabled={!notes.trim() || isGenerating}
                  onClick={handleGenerate}
                  className="w-full flex items-center justify-center gap-3 py-5 px-6 bg-emerald-600 text-white rounded-2xl font-bold text-lg hover:bg-emerald-700 shadow-lg shadow-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {isGenerating ? (
                    <>
                      <RefreshCw className="animate-spin" size={24} />
                      Creating your study set...
                    </>
                  ) : (
                    <>
                      <Sparkles size={24} />
                      Generate Complete Study Set
                    </>
                  )}
                </button>
              </div>

              {studySets.length > 0 && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold">Recent Study Sets</h2>
                    <button onClick={() => setCurrentPage('history')} className="text-sm font-bold text-emerald-600 hover:underline">View All</button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {studySets.slice(0, 3).map((set) => (
                      <StudySetCard 
                        key={set.id} 
                        set={set} 
                        onQuiz={() => startQuiz(set)}
                        onFlash={() => { setActiveSet(set); setCurrentPage('flashcards'); }}
                        onDelete={(e) => handleDeleteSet(e, set.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {currentPage === 'history' && (
            <motion.div
              key="history"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-8"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-3xl font-bold">My Library</h2>
                <button 
                  onClick={() => setCurrentPage('home')}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-bold hover:bg-emerald-700 transition-all"
                >
                  <Plus size={18} />
                  New Set
                </button>
              </div>

              {studySets.length === 0 ? (
                <div className="py-20 text-center space-y-4 bg-white rounded-3xl border border-black/5">
                  <div className="w-16 h-16 bg-zinc-50 rounded-full flex items-center justify-center mx-auto text-zinc-300">
                    <History size={32} />
                  </div>
                  <p className="text-zinc-500">You haven't created any study sets yet.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {studySets.map((set) => (
                    <StudySetCard 
                      key={set.id} 
                      set={set} 
                      onQuiz={() => startQuiz(set)}
                      onFlash={() => { setActiveSet(set); setCurrentPage('flashcards'); }}
                      onDelete={(e) => handleDeleteSet(e, set.id)}
                    />
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {currentPage === 'quiz' && activeSet && (
            <motion.div
              key="quiz"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="max-w-2xl mx-auto space-y-8"
            >
              <button 
                onClick={() => setCurrentPage('history')}
                className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors"
              >
                <ArrowLeft size={18} />
                <span>Back to library</span>
              </button>

              {!quizFinished ? (
                <div className="space-y-8">
                  <div className="flex justify-between items-end">
                    <div className="space-y-1">
                      <span className="text-xs font-bold uppercase tracking-widest text-emerald-600">Question {currentQuizIndex + 1} of {activeSet.quiz.length}</span>
                      <h2 className="text-2xl font-bold text-zinc-900">{activeSet.quiz[currentQuizIndex].question}</h2>
                    </div>
                  </div>

                  <div className="grid gap-3">
                    {activeSet.quiz[currentQuizIndex].options.map((option, i) => (
                      <button
                        key={i}
                        onClick={() => handleQuizAnswer(option)}
                        disabled={!!selectedOption}
                        className={cn(
                          "w-full p-5 text-left rounded-2xl border-2 transition-all flex items-center justify-between group",
                          !selectedOption && "border-zinc-100 hover:border-emerald-500 hover:bg-emerald-50/50",
                          selectedOption === option && option === activeSet.quiz[currentQuizIndex].correctAnswer && "border-emerald-500 bg-emerald-50",
                          selectedOption === option && option !== activeSet.quiz[currentQuizIndex].correctAnswer && "border-red-500 bg-red-50",
                          selectedOption && option === activeSet.quiz[currentQuizIndex].correctAnswer && "border-emerald-500 bg-emerald-50"
                        )}
                      >
                        <span className="font-medium">{option}</span>
                        {selectedOption === option && (
                          option === activeSet.quiz[currentQuizIndex].correctAnswer ? <CheckCircle2 className="text-emerald-600" size={20} /> : <XCircle className="text-red-600" size={20} />
                        )}
                      </button>
                    ))}
                  </div>

                  {selectedOption && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-6 bg-white rounded-2xl border border-black/5 space-y-4"
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn("text-sm font-bold uppercase tracking-wider", isCorrect ? "text-emerald-600" : "text-red-600")}>
                          {isCorrect ? "Correct!" : "Incorrect"}
                        </span>
                      </div>
                      <p className="text-zinc-600 text-sm leading-relaxed">
                        {activeSet.quiz[currentQuizIndex].explanation}
                      </p>
                      <button
                        onClick={nextQuestion}
                        className="w-full py-4 bg-zinc-900 text-white rounded-xl font-semibold hover:bg-zinc-800 transition-all flex items-center justify-center gap-2"
                      >
                        {currentQuizIndex + 1 === activeSet.quiz.length ? "Finish Quiz" : "Next Question"}
                        <ChevronRight size={18} />
                      </button>
                    </motion.div>
                  )}
                </div>
              ) : (
                <div className="bg-white rounded-3xl p-12 text-center space-y-6 shadow-sm border border-black/5">
                  <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto text-emerald-600">
                    <CheckCircle2 size={40} />
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-3xl font-bold text-zinc-900">Quiz Completed!</h2>
                    <p className="text-zinc-500">You scored {quizScore} out of {activeSet.quiz.length}</p>
                  </div>
                  <div className="text-5xl font-black text-emerald-600">
                    {Math.round((quizScore / activeSet.quiz.length) * 100)}%
                  </div>
                  <button
                    onClick={() => setCurrentPage('history')}
                    className="px-8 py-4 bg-zinc-900 text-white rounded-2xl font-semibold hover:bg-zinc-800 transition-all"
                  >
                    Back to Library
                  </button>
                </div>
              )}
            </motion.div>
          )}

          {currentPage === 'flashcards' && activeSet && (
            <motion.div
              key="flashcards"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-8"
            >
              <div className="flex items-center justify-between">
                <button 
                  onClick={() => setCurrentPage('history')}
                  className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors"
                >
                  <ArrowLeft size={18} />
                  <span>Back to library</span>
                </button>
                <h2 className="font-bold text-zinc-400 uppercase tracking-widest text-xs">{activeSet.title}</h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {activeSet.flashcards.map((card, i) => (
                  <FlashcardItem key={i} card={card} />
                ))}
              </div>
            </motion.div>
          )}

          {currentPage === 'contact' && (
            <motion.div
              key="contact"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="max-w-xl mx-auto space-y-8"
            >
              <div className="text-center space-y-4">
                <h2 className="text-4xl font-bold tracking-tight text-zinc-900">Get in touch</h2>
                <p className="text-zinc-500">Have questions or feedback? We'd love to hear from you.</p>
              </div>

              <form 
                action="https://formspree.io/f/mnjgvryd" 
                method="POST"
                className="bg-white p-8 rounded-3xl shadow-sm border border-black/5 space-y-6"
              >
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">Your Name</label>
                  <input 
                    type="text" 
                    name="name" 
                    required
                    defaultValue={user?.displayName || ''}
                    placeholder="Jane Doe"
                    className="w-full p-4 bg-zinc-50 border border-zinc-200 rounded-xl focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">Email Address</label>
                  <input 
                    type="email" 
                    name="email" 
                    required
                    defaultValue={user?.email || ''}
                    placeholder="jane@example.com"
                    className="w-full p-4 bg-zinc-50 border border-zinc-200 rounded-xl focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">Message</label>
                  <textarea 
                    name="message" 
                    required
                    placeholder="How can we help?"
                    className="w-full h-32 p-4 bg-zinc-50 border border-zinc-200 rounded-xl focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all resize-none"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-4 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 transition-all flex items-center justify-center gap-2"
                >
                  <Mail size={18} />
                  Send Message
                </button>
              </form>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="mt-auto py-12 border-t border-black/5">
        <div className="max-w-5xl mx-auto px-6 text-center space-y-4">
          <div className="flex items-center justify-center gap-2 opacity-50">
            <GraduationCap size={20} />
            <span className="font-bold">NoteQuizzer</span>
          </div>
          <p className="text-sm text-zinc-400">© 2026 NoteQuizzer. Powered by Google Gemini.</p>
        </div>
      </footer>
    </div>
  );
}

function StudySetCard({ set, onQuiz, onFlash, onDelete }: { 
  set: StudySet, 
  onQuiz: () => void, 
  onFlash: () => void,
  onDelete: (e: React.MouseEvent) => void 
}) {
  return (
    <div className="bg-white rounded-3xl p-6 border border-black/5 shadow-sm hover:shadow-md transition-all group relative">
      <button 
        onClick={onDelete}
        className="absolute top-4 right-4 p-2 text-zinc-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
      >
        <Trash2 size={16} />
      </button>
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="font-bold text-lg text-zinc-900 line-clamp-1">{set.title}</h3>
          <p className="text-xs text-zinc-400 font-medium">
            {new Date(set.createdAt?.seconds * 1000).toLocaleDateString()}
          </p>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={onQuiz}
            className="flex-1 py-2 bg-zinc-900 text-white rounded-xl text-xs font-bold hover:bg-zinc-800 transition-all flex items-center justify-center gap-2"
          >
            <BrainCircuit size={14} />
            Quiz
          </button>
          <button 
            onClick={onFlash}
            className="flex-1 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition-all flex items-center justify-center gap-2"
          >
            <BookOpen size={14} />
            Cards
          </button>
        </div>
      </div>
    </div>
  );
}

function FlashcardItem({ card }: { card: Flashcard }) {
  const [isFlipped, setIsFlipped] = useState(false);

  return (
    <div 
      className="perspective-1000 h-64 cursor-pointer group"
      onClick={() => setIsFlipped(!isFlipped)}
    >
      <motion.div
        animate={{ rotateY: isFlipped ? 180 : 0 }}
        transition={{ duration: 0.6, type: "spring", stiffness: 260, damping: 20 }}
        className="relative w-full h-full preserve-3d"
      >
        {/* Front */}
        <div className="absolute inset-0 backface-hidden bg-white p-8 rounded-2xl border border-black/5 shadow-sm flex items-center justify-center text-center">
          <p className="text-lg font-bold text-zinc-900 leading-tight">{card.front}</p>
          <div className="absolute bottom-4 text-[10px] font-bold uppercase tracking-widest text-zinc-300 group-hover:text-emerald-500 transition-colors">Click to flip</div>
        </div>

        {/* Back */}
        <div 
          className="absolute inset-0 backface-hidden bg-emerald-600 p-8 rounded-2xl text-white flex items-center justify-center text-center"
          style={{ transform: 'rotateY(180deg)' }}
        >
          <p className="text-sm font-medium leading-relaxed">{card.back}</p>
        </div>
      </motion.div>
    </div>
  );
}
