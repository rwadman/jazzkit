#!/bin/bash
mkdir -p logs
"$MUSE_SCORE_FOLDER" -d 2>&1 | tee logs/musescore-run.log