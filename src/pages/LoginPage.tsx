import { I18N } from '@common/I18N';
import { Session } from '@common/Session';
import { Shared } from '@common/Shared';
import { Center } from '@components/Center';
import { useHistory } from '@contexts/HistoryContext';
import { Button, CircularProgress, Paper, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

export const LoginPage = (): JSX.Element => {
	const history = useHistory();
	const [isLoading, setLoading] = useState(true);
	const [scrobUrl, setScrobUrl] = useState(Shared.storage.options.scrobUrl || '');
	const [scrobApiKey, setScrobApiKey] = useState(Shared.storage.options.scrobApiKey || '');

	const onLoginClick = async (): Promise<void> => {
		setLoading(true);
		await Session.login();
	};

	const onSkipClick = () => {
		history.push('/home');
	};

	const onScrobSaveClick = async (): Promise<void> => {
		await Shared.storage.saveOptions({
			scrobUrl: scrobUrl.trim(),
			scrobApiKey: scrobApiKey.trim(),
		});
		history.push('/home');
	};

	useEffect(() => {
		const startListeners = () => {
			Shared.events.subscribe('LOGIN_SUCCESS', null, onLoginSuccess);
			Shared.events.subscribe('LOGIN_ERROR', null, onLoginError);
		};

		const stopListeners = () => {
			Shared.events.unsubscribe('LOGIN_SUCCESS', null, onLoginSuccess);
			Shared.events.unsubscribe('LOGIN_ERROR', null, onLoginError);
		};

		const onLoginSuccess = () => {
			setLoading(false);
			if (Shared.redirectPath) {
				history.push(Shared.redirectPath);
			} else {
				history.push('/home');
			}
		};

		const onLoginError = () => {
			setLoading(false);
		};

		startListeners();
		return stopListeners;
	}, []);

	useEffect(() => {
		const init = async () => {
			await Session.checkLogin();
		};

		void init();
	}, []);

	const hasScrob = !!(Shared.storage.options.scrobUrl && Shared.storage.options.scrobApiKey);

	return (
		<Center isHorizontal={false} sx={{ height: 1, px: 2, py: 1 }}>
			{isLoading ? (
				<CircularProgress color="secondary" />
			) : (
				<>
					{/* Always shown on a solid card: over the blurred background the fields were easy to miss. */}
					<Paper elevation={6} sx={{ p: 2, width: 1, maxWidth: 380 }}>
						<Typography variant="h6" sx={{ mb: 1 }}>
							{I18N.translate('useScrob')}
						</Typography>
						<TextField
							label={I18N.translate('scrobUrl')}
							placeholder="https://trak.example.com"
							value={scrobUrl}
							onChange={(event) => setScrobUrl(event.target.value)}
							size="small"
							variant="filled"
							fullWidth
							autoFocus={!hasScrob}
						/>
						<TextField
							label={I18N.translate('scrobApiKey')}
							type="password"
							value={scrobApiKey}
							onChange={(event) => setScrobApiKey(event.target.value)}
							size="small"
							variant="filled"
							fullWidth
							sx={{ mt: 1 }}
						/>
						<Button
							color="primary"
							disabled={!scrobUrl.trim() || !scrobApiKey.trim()}
							onClick={() => void onScrobSaveClick()}
							variant="contained"
							fullWidth
							sx={{ mt: 1.5 }}
						>
							{I18N.translate('save')}
						</Button>
						{hasScrob && (
							<Button
								color="primary"
								onClick={onSkipClick}
								variant="text"
								fullWidth
								sx={{ mt: 0.5 }}
							>
								{I18N.translate('skipToHome')}
							</Button>
						)}
					</Paper>
					<Button
						color="secondary"
						onClick={() => void onLoginClick()}
						variant="text"
						size="small"
						sx={{ mt: 1 }}
					>
						{I18N.translate('login')}
					</Button>
				</>
			)}
		</Center>
	);
};
