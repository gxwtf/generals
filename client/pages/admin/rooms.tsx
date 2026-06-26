import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import { useTranslation } from 'next-i18next';
import { useState, useEffect, StrictMode } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Typography,
  Button,
  Box,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Snackbar,
  Alert,
} from '@mui/material';
import { Room, RoomPool } from '@/lib/types';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import theme from '@/components/theme';
import Head from 'next/head';

export default function AdminRooms() {
  const [rooms, setRooms] = useState<RoomPool>({});
  const [loading, setLoading] = useState(true);
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null);
  const [snackOpen, setSnackOpen] = useState(false);
  const [snackMessage, setSnackMessage] = useState('');
  const [snackSeverity, setSnackSeverity] = useState<'success' | 'error'>('success');
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [username, setUsername] = useState('');

  const { t } = useTranslation();

  useEffect(() => {
    const storedUsername = localStorage.getItem('username');
    if (storedUsername) {
      setUsername(storedUsername);
    }
  }, []);

  useEffect(() => {
    console.log('fetching rooms from: ', process.env.NEXT_PUBLIC_SERVER_API);
    const fetchRooms = async () => {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_SERVER_API}/get_rooms`
        );

        const rooms = await res.json();
        setRooms(rooms);
        setLoading(false);
      } catch (err: any) {
        setLoading(false);
        setSnackOpen(true);
        setSnackMessage(err.message);
        setSnackSeverity('error');
      }
    };
    fetchRooms();
    let fetchInterval = setInterval(fetchRooms, 2000);
    return () => {
      clearInterval(fetchInterval);
    };
  }, []);

  const handleDeleteClick = (room: Room) => {
    setSelectedRoom(room);
    setConfirmDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!selectedRoom) return;
    
    setDeleteLoading(selectedRoom.id);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SERVER_API}/rooms/${selectedRoom.id}`,
        {
          method: 'DELETE',
        }
      );

      if (res.ok) {
        setSnackOpen(true);
        setSnackMessage(t('room-deleted-success'));
        setSnackSeverity('success');
        
        // 从本地状态中移除已删除的房间
        const updatedRooms = { ...rooms };
        delete updatedRooms[selectedRoom.id];
        setRooms(updatedRooms);
      } else {
        const data = await res.json();
        setSnackOpen(true);
        setSnackMessage(data.message || t('delete-room-failed'));
        setSnackSeverity('error');
      }
    } catch (err: any) {
      setSnackOpen(true);
      setSnackMessage(err.message || t('delete-room-failed'));
      setSnackSeverity('error');
    } finally {
      setDeleteLoading(null);
      setConfirmDialogOpen(false);
      setSelectedRoom(null);
    }
  };

  const handleCancelDelete = () => {
    setConfirmDialogOpen(false);
    setSelectedRoom(null);
  };

  const handleSnackClose = () => {
    setSnackOpen(false);
  };

  return (
    <StrictMode>
      <ThemeProvider theme={theme}>
        <Head>
          <title>{t('room-management')} | Generals</title>
        </Head>
        <Box>
          <Navbar />
          
          <Box sx={{ flex: 1, p: 3 }}>
            {Object.keys(rooms).length === 0 && !loading ? (
              <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
                <Typography variant="h6" color="white">
                  {t('no-rooms')}
                </Typography>
              </Box>
            ) : (
              <TableContainer 
                component={Paper} 
                sx={{ 
                  maxWidth: { xs: '100%', md: 1200 }, 
                  mx: 'auto',
                  maxHeight: '50vh',
                  overflow: 'auto'
                }}
              >
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('room-name')}</TableCell>
                      <TableCell>{t('game-speed')}</TableCell>
                      <TableCell>{t('players')}</TableCell>
                      <TableCell>{t('actions')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {loading ? (
                      <TableRow>
                        <TableCell colSpan={5} align="center">
                          <CircularProgress />
                        </TableCell>
                      </TableRow>
                    ) : Object.keys(rooms).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} align="center">
                          {t('no-rooms')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      Object.values(rooms).map((room) => (
                        <TableRow key={room.id}>
                          <TableCell>{room.roomName}</TableCell>
                          <TableCell>{room.gameSpeed}</TableCell>
                          <TableCell>{room.players.length}/{room.maxPlayers}</TableCell>
                          <TableCell>
                            <Button
                              variant="contained"
                              color="error"
                              size="small"
                              onClick={() => handleDeleteClick(room)}
                              disabled={deleteLoading === room.id}
                            >
                              {deleteLoading === room.id ? t('deleting') : t('delete')}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
          
          <Footer />
        </Box>
        
        {/* 确认删除对话框 */}
        <Dialog open={confirmDialogOpen} onClose={handleCancelDelete}>
          <DialogTitle>{t('confirm-delete')}</DialogTitle>
          <DialogContent>
            <Typography>
              {t('confirm-delete-message')} &quot;{selectedRoom?.roomName}&quot;?
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {t('delete-warning')}
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleCancelDelete}>{t('cancel')}</Button>
            <Button 
              onClick={handleConfirmDelete} 
              color="error"
              disabled={deleteLoading === selectedRoom?.id}
            >
              {deleteLoading === selectedRoom?.id ? t('deleting') : t('confirm-delete-action')}
            </Button>
          </DialogActions>
        </Dialog>
        
        {/* 消息提示 */}
        <Snackbar
          open={snackOpen}
          autoHideDuration={3000}
          onClose={handleSnackClose}
        >
          <Alert 
            onClose={handleSnackClose} 
            severity={snackSeverity}
            sx={{ width: '100%' }}
          >
            {snackMessage}
          </Alert>
        </Snackbar>
        
        <Footer />
      </ThemeProvider>
    </StrictMode>
  );
}

export async function getStaticProps(context: any) {
  const { locale } = context;

  return {
    props: {
      ...(await serverSideTranslations(locale)),
    },
  };
}