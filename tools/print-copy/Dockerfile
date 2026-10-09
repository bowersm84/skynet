# skynet-print-copy - Lambda container image (SkyNet S14, D-TKIOSK-11a)
# Ubuntu 24.04 + LibreOffice 24.2 headless: the same LibreOffice build the
# converter was tested against. Python deps pinned to the tested versions.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-calc-nogui python3-uno python3 python3-pip ca-certificates \
      fonts-crosextra-carlito fonts-crosextra-caladea \
      fonts-liberation fonts-liberation2 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
      awslambdaric==4.2.0 boto3==1.43.109 openpyxl==3.1.5 xlrd==2.0.2 pypdf==5.9.0

# Lambda: everything outside /tmp is read-only.
ENV HOME=/tmp \
    SAL_USE_VCLPLUGIN=svp \
    SOFFICE_PROFILE_DIR=/tmp/lo-profile \
    PYTHONUNBUFFERED=1
RUN fc-cache -f

WORKDIR /var/task
COPY convert.py handler.py ./

ENTRYPOINT ["/usr/bin/python3", "-m", "awslambdaric"]
CMD ["handler.handler"]
